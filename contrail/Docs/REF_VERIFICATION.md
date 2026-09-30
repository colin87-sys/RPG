# Reference verification (GAME_FORGE W1, seed-pack mode 4.6)

Author: Reference Analyst lane, 2026-09-30T05:39Z. Scope: I checked `Docs/refs/ANALYSIS.md`, `Docs/refs/owner_refs.md` and the [O] claims in `Docs/seed/DESIGN_SEED.md` and `Docs/seed/STYLE_SEED.md` against the reference images.

**Copyright note.** The reference pack belongs to a third party and stays private. This file contains only numbers, colour values and my own descriptions. No reference pixels were copied into the repo. Measurement crops were written only to the session scratchpad. UI wording from the reference is not transcribed; elements are named generically (for example "score label" or "warning banner").

**How I measured.** I loaded the images into a canvas with Playwright/Chromium and read pixel values from it. A colour marked "median" is the per-channel median of the named region. Frame coordinates are given in the image's own pixels: the stills are 1920x1080 (01 and 15-18 are 1280x720) and the clip frames are 800x450. A time `t` is taken from the frame file name (about 15 fps, so each frame step is about 0.067 s).

## 1. Coverage (evidence)
- **Stills opened (18 of 18):** 01 through 18, each opened in full. I also viewed zoomed crops of 01 (craft), 03 (reticle, orbs, brackets, smoke, large orb), 04 (orbs, laser), 06 (beam), 07 (vents), 08 (hazard rails, ring, orbs), 09 and 10 (HUD outlines).
- **Contact sheets opened (4 of 4):** m1 every 6th frame, m2 every 3rd, m3 every 3rd, m4 every 6th.
- **Frames opened (92 of 92, every frame of every clip):**
  - m1_f000-f031 (32 frames)
  - m2_f000-f013 (14 frames)
  - m3_f000-f013 (14 frames)
  - m4_f000-f031 (32 frames)

## 2. Verdict table

Verdicts: **confirmed** means the entry is accurate as written. **partly** means the core idea holds but a detail is wrong or missing. **corrected** means the main claim is wrong. Every lesson in the last column is meant to be checkable on a capture.

| Entry | Verdict | What is actually visible | Corrected `what_to_take_from_it` (one testable lesson) |
|---|---|---|---|
| owner-001 sky bank | partly | The craft is dark navy-charcoal with yellow-orange emissive windows and engine fire. It sits in the upper-left third, with its centre at about 36% x / 37% y, above and to the right of the reticle, not in a low chase position. The combat text top-left is red (event name) plus green (hit count and seconds), and it is not the only text. The main HUD labels (score, weapon, shield) are **white**. The sky goes from #0939AF (just below the HUD band) to #1695D5 at mid-height and #F8F9F0 near the horizon; the 95th-percentile luminance is 92%. There is a thin white horizontal glare streak across the frame and a large faint chromatic halo on the right. | A dark craft body (luminance under 8%) with emissive orange stays readable against a sky that reaches about 92% luminance. HUD text stays readable over that sky because the bands carry a dark scrim (section 4). Test: on a Cloudgate capture, craft body luminance is under 10% while the sky around it is over 60%. |
| owner-002 violet sunset | partly | The upper sky is indigo #0C0D45 to #120F4D, the glow around the sun is plum #8E3A5A and pink #F57B96, the sun core is #FEFEB2, and the horizon band runs from #F25413 through #F99720 to #FDF73F. The cloud sea below is plum #201220 to #4C2738 on top and fades to navy-black #060E20. The **median luminance of the whole frame is 2.3%**, so it is mostly dark. The craft sits lower-right (centre about 65% x / 76% y) and is about 16% of the frame width. It is lit warm gold. The "flock" is about 150 small dark shards spread radially around the sun. The missile trail is **thin**, a cream curl about 1.5-2.5% of frame height wide, not a thick ribbon. The yellow orbs next to the bracketed target cannot be assigned to player or enemy. | The sunset stage is a **dark** frame (median luminance 2-5%) with one narrow bright band: the sun plus the horizon strip, about 35-45% of frame height. The warm-lit craft is the second-brightest object. Test: median luminance under 6%, and more than 80% of pixels brighter than 50% luminance fall inside that band or the craft. |
| owner-003 missile paths | partly | Smoke ribbons are confirmed. They are built from overlapping round puffs, cream #DCCBAA on the lit side with a greyer underside, and red/cyan fringing along the edges. Width is 16-23% of frame height near the camera and about 6% far away. The orbs are **flat saturated yellow cores (#FEFE00) with an orange rim (#F38407) and a dim orange halo**; the core is not white. Core diameter is 1.9-3.3% of frame height, halo 3.5-5.3%, and one orb close to the camera reaches 9.8%. The lock on the target is **3-4 overlapping red corner brackets (#FB0200)**, each with one thick bar segment and a small red diamond. A green "+N missiles" pop-up sits beside them. | Lock-ons stack: each lock adds one bracket set plus one diamond, offset a few pixels from the previous one, so the lock count can be read from the target. Test: with N locks on one enemy, a capture shows N bracket sets. |
| owner-004 cloud corridor | partly | The sky runs from deep blue #0136B2 to #0151CD to cyan #15A0F1, and the clouds are near-white #FCE6E1 to #FDFAF9. The lower third is a flat fog sea, #B4C2B2 to #D0D6C2. The right-hand structure is **dark slate #1F3B48 to #2D424F** (luminance about 4%). The red beams start as a point near the centre and widen toward the top-left corner, so they come from a distant emitter toward the camera. They are pure red #FD0102 with a pink bloom #FDA5B7 that tints nearby clouds pink. The orbs are low-poly yellow discs (#FEFC07) with pale rims and a **pink-magenta halo #F59FD7 on the blue sky**. Core is 3.6-5.3% of frame height; halo is 7.9-10.9%. The craft is upper-left of centre. Small "star" drones sit at right-centre. | A dark slate structure (luminance under 6%) filling about 30% of the frame on one side, next to fog above 50% luminance, gives the corridor its depth. Warm threats read against the blue sky because their halos turn pink against it. Test: the side mass is under 6% luminance and the fog next to it is over 45%. |
| owner-005 hot stage | confirmed | The background is saturated orange #FE8701 to #FE9E01 with white peaks #FEFEFD. The three drones are dark charcoal with a red three-dot face and dark spikes. The curly flame tendrils have red outlines and yellow insides. Orbs have core #FEFE01, rim #FD9600 and halo #FD7401, while the background next to them is #F87400: **the halo is the same colour as the background**, so only the flat yellow core separates an orb from it (luminance ratio about 2.3:1, against more than 20:1 on space). The HUD's small green corner label disappears over the yellow blast. | Warm fire over a warm background fails. The failure is measurable: hostile core-to-background luminance ratio under 3:1 and hue difference under 30 degrees. We ship no stage where that happens. |
| owner-006 beam threat | corrected | The beam is a **broad flat white core (#FDFDFD), about 60-70% of total beam width** (197 px of 290 px at the right edge). A thin yellow line #FDF776 runs along the core edge. A red-orange halo about 60-75 px wide sits on the upper side and fades to dark red #7B1C15. The beam narrows toward the red-bracketed emitter, so it points at the camera. The shield reads 48 and the portrait is tinted **entirely red** (monochrome). There is heavy RGB split and grain throughout. | The beam threat is **white core, about 65% of width, plus a thin yellow edge line, plus a red halo about 25% of width per side**. Damage state tints the whole pilot frame red. Test: the beam cross-section shows W, then Y, then R in that order from the centre outward. |
| owner-007 boss scale | partly | The boss underside is near-black navy #071024 against sky #086BA2 and #0371B5. Rows of vertical yellow slot vents sit on red-orange frames, together with circular red-rim pods. **Five or more yellow beams (#FDFE06, white core #FEFEF9)** fan upward, each 140-200 px wide (7-10% of frame width) near the top edge. **The right top-HUD segment shows a full green bar during this fight** (x 1520-1868, y 35-60), probably boss health. The progress bar is full. The portrait is normal at shield 39. | A boss reads when a near-black silhouette (luminance under 2%) covers more than 50% of the frame width in front of a mid-blue sky, and its attack beams are saturated yellow and at least as wide on screen as the player craft. Show boss health in the top-right HUD segment. |
| owner-008 shock / speed | corrected | The ring is an ellipse about 49% of frame width (outer edge x 485-1432), aspect about 0.55. It is made of **three separated colour bands: red on the inside, green in the middle, blue-violet on the outside**, each 9-31 px wide, together about 13% of the ring radius. Radial speed streaks are dense at all four edges. **The hazard state is not a striped border.** It adds two solid olive-yellow rails with bright yellow outlines under the top band, following its chamfers, plus yellow trapezoid tabs on the top edge and a yellow single-line banner in the thin HUD font framed by slash marks. The special chip shows three red dashes (charging). The combo bar is 50% full. | The hazard state is **two parallel solid yellow rails, each about 1% of frame height, plus a centred banner at about 14% of frame height**. The rails blink (see m3). Test: in the hazard state, yellow rail pixels appear in the 9-13% height band of the frame. |
| owner-009 top HUD | partly | Three chamfered segments outlined by a thin line in pure green #00B809 (anti-aliased core #00C20C), about 2 px wide at 1080p. The **main labels and values are white #FCFEFA**. The corner labels are small bold green #04B307 (cap height about 0.75% of frame height). The progress bar has a white 1-px border and a black empty fill, is 17% of frame width and 2.3% of frame height. **The lower border line sits at 8.5% of frame height** (y 91-92 of 1080); the top line is at 0.5%. **The band has a dark scrim** (section 4). | Top band: outline plus a 30% black scrim, height 8.5%, white primary text, green used only for outlines and small labels. Test: the lower border of the top band sits at 8.5% ± 0.5% of frame height. |
| owner-010 bottom HUD | partly | The top edge of the side cells sits at 9.1% of frame height (y 982); the diagonal joins between cells dip to 7.8%. The bottom line is at 0.5%. Bars span y 1016-1047 (2.8-3% of frame height). Shield bar: red #FF1C01 fill, white border, white numerals, 12% of frame width. The ready chip is filled bright green #00FD02 with dark text #02570A. The combo label is green #06DD08; the weapon, special and shield labels are white. The ship icons are bright green #02FC03 or dark. The same 30% scrim is present. | Colour, shape and label always go together: the chip changes both fill and text (green READY versus red dashes), and the shield is the only red fill in the HUD. Test: no other HUD element uses red fill. |
| owner-011 hangar | corrected | The grid is a **full-screen cyan-grey overlay across the backdrop**, not a floor grid. The craft is shown half shaded (white hull with orange panels) and half wireframe. Chunky bevelled metallic frames have rivets. The left column is blue, then orange, then grey buttons. The list is saturated green buttons with the selected item brighter. There is a green schematic panel on the right and a red back button. Strong RGB split and scanlines. | Menu language: flat saturated fills (blue, orange, green, red) inside bevelled grey metal frames, with a shaded-plus-wireframe craft preview. Test: every button has a bevelled frame and one of four fill families. |
| owner-012 decals | confirmed | The hull is warm off-white (#BEA896 to #CDB8A7). An orange-yellow emissive grille (fine vertical stripes) sits in a black frame. A black oval-disc emblem, engraved panel lines drawn as emboss rather than dark ink, and small red dots. | Panel detail comes from engraved seams (light and shadow pairs) and one high-contrast emblem on a black disc. Test: the hull close-up shows seam lines and exactly one emblem per side. |
| owner-013 character menu | confirmed | Three suits: all-orange, white with ochre panels, all-white. Colour blocks are separated by **thick black piping**. Dark industrial hall. Same menu frame as 011. | Pilot suit is white with ochre blocks separated by black piping lines about 2% of figure height. We use it on a visored helmet figure only. |
| owner-014 yellow livery | corrected | Top view of the craft in a hex-pattern yellow livery. The **silhouette is unchanged**. The central fuselage and engine block stay grey in every livery; only the wing and fin panels take livery paint and pattern. Small orange emissive lights are scattered across the dark hangar. | A livery is a swap of palette and pattern on wing and fin panels only; the fuselage stays neutral grey. Test: the silhouette mask is identical across liveries. |
| owner-015 hull close-up | confirmed | Warm light-grey hull (#A89A81 to #BBA589). Canopy is deep saturated blue (#0A3785 to #2A447D) with white glints. Vents are octagonal red-orange frames around dense yellow stripes (#F8E210). Red-orange accent panels. A tiny pilot figure stands on the wing for scale. Engine fire has a #FAFF0C core and #E44506 edge. | Neutral warm hull plus a single cool accent (the canopy) plus emissive yellow-in-red vents. Test: the canopy is the only blue on the craft. |
| owner-016 cockpit | partly | The interior is dark-mid blue-grey (#1A1D21 to #344143; 95th-percentile luminance 12.7%), not black. Small emissive details: a green text screen, a red screen, a red/yellow/white LED cluster, an orange lever and a red arc handle. | First-person interior: luminance under 15% everywhere except fewer than 10 small emissive details. |
| owner-017 pilot in craft | partly | Top-down view into a long open cockpit bay. Warm light hull (#CDBAA8) with dark seams, a large black-and-white chevron emblem, red dots, red handles and a black louvre row. The "red pinstripe" is only a thin red edge at the top of the frame. | Scale cue: the seated pilot is about 1/3 of the bay width. Red appears only as small accents (dots, handles), under 2% of the hull area. |
| owner-018 frontal silhouette | corrected | Seen from the front: fuselage with a V keel, horizontal wings, and **tall crescent fins mounted at about 55% of the half-span, not at the wingtips**. The wings extend past the fins to flat tips with red stripes. The fins are about 38% of the span tall and rise above and below the wing. Yellow-orange inserts sit either side of a small blue-lit canopy. A standing pilot below gives a span of about 12.8 pilot heights if both are at the same depth, which is a much larger craft than the seed's 9 m. | Front silhouette test: two tall crescent fins inboard (40-60% of the half-span) with wing extending beyond them. Test: in a black-mask front view, the two fin arcs are the tallest features and do not sit at the tips. |
| motion-m1 missile salvo | corrected | **Three** plumes, not two: one thick plume from the lower left and two thinner ones from the bottom centre. They converge on **two** bracketed targets at 45-52% x / 30-45% y. Orange tracer lines come in from the left **from t=0**. The white bloom at the target head runs from 0.33 to 0.9 s. The rainbow band at lower right begins at 0.33 s. Speed streaks become dense from about 0.6 s. The camera rolls so that by 1.07 s the plumes fan out from the target toward the right. The score ticks up at 1.40 s and the double bracket collapses to a single bracket. **The ring appears at 1.67 s already about 55% of frame width** (outer edge; about 52% band centre, aspect 0.58), together with an orange fireball on the target. It is centred on the target, grows to about 56% by 2.07 s, and is still at full strength at the end of the clip. A faint large ring also appears at 0.53 s. | A kill ring pops at full size (±5% of frame width) centred on the killed target, holds for at least 0.4 s, and grows by under 10% of its size. Smoke ribbons persist for the whole 2.07 s shot. Test: ring width in the first frame is at least 90% of its width at its largest. |
| motion-m2 explosion + drones | corrected | The clip starts mid-explosion. The yellow mass (#F9FF12, bright spots #FAFF7C, orange chunks #EA821A) grows from about 15% to about 30% of frame width between 0.00 and 0.30 s: **about 2x, not 3x**. The debris is angular orange chunks, not only round blooms. The 4-5 drones are dark spiky bodies with glowing red-orange cores, spaced 5-8% of frame width in a loose line. **The camera does not follow the craft.** The craft slides from 73%/75% to 16%/55% (about 57% of frame width) and yaws about 150 degrees to side-on within 0.8 s while the clouds stay fixed. The hard cut lands between 0.80 and 0.87 s. The post-cut frame has a ring about 52% of frame width. | An explosion doubles its visible diameter in about 0.3 s and throws angular orange chunks. During a drift the camera holds while the craft travels across up to 60% of the frame. Test: in a drift capture, the craft's screen position changes by more than 30% of frame width within 0.8 s. |
| motion-m3 drift/bank | corrected | The craft starts at 36%/37% in a rear-quarter view (wing line about 35-40 degrees on screen). It slides to 17%/80% and ends **side-on**, fuselage axis 18-32 degrees nose-up to the right, with its tail overlapping the bottom HUD band. The 60-70 to 20 degree bank values cannot be recovered from 2D. A cloud whiteout covers 0.13-0.35 s (almost the whole frame is #D0D0C8 or brighter). **The red event label slides out to the left and is gone by 0.20 s; the green counter stays and counts up in real time** (0.6 to 1.4 s over 0.73 s of clip). The red text does not turn green. The portrait shows static and scan-bar glitches at about 0.15, 0.27 and 0.47 s. A faint ring about 51% wide shows at 0.47 s. The cut lands between 0.73 and 0.80 s. In the hazard frames the yellow rails are on at 0.80 s and off at 0.87 s while the banner stays, so **the rails blink**. | A drift reads as a rotation to side-on (at least 60 degrees of yaw) plus a slide of at least 40% of frame height. The event label leaves within 0.2 s while the counter persists. Test: capture frames 0.2 s apart. |
| motion-m4 strider corridor | corrected | The strider holds the top centre (50% x, 15-40% y). It is dark with red panels and **turns red-orange over its whole body when hit (0.53-0.8 s)**; this is its hit flash, and it is not white. The side structure is **mid grey-blue (#778C96, luminance about 25%) here**, not dark. The craft starts large at the left (about 20% of frame width), flies into the scene and shrinks to about 5%, so the camera lets it surge ahead. The red lasers **grow outward from the strider toward the bottom corners** at about 1.5 frame widths per second (1.33-1.6 s), red #DF2F3B, 50-70 px wide near the bottom. Earlier lasers are visible from 0.07 s. **Three yellow orbs move down the screen** (from 62% to 82% of frame height) while spreading and growing from 2.5% to 6.5% of frame height: they are approaching the camera, not rising. Ring #1 is visible only at 0.80-0.93 s, about 44% of frame width, and gone at 1.00 s. **Ring #2 appears at 1.53-1.60 s at about 48% and reaches about 53% by 2.07 s**, still bright, with a faint outer ring starting at 2.0 s. No ring reaches 65%. A green floating "+shield" label stays beside the reticle. There is slight camera roll. | Enemy lasers visibly extend from the emitter at about 1.5 screen widths per second, which gives a readable 0.2-0.3 s warning. Hostile orbs are read as incoming because they grow at least 2x on screen. Test: laser tip positions across 4 frames increase monotonically from the emitter. |

**Tally:** 22 entries. Confirmed 4 (005, 012, 013, 015). Partly 9 (001, 002, 003, 004, 007, 009, 010, 016, 017). Corrected 9 (006, 008, 011, 014, 018, m1, m2, m3, m4). Individual [O] claims I **cannot verify** from the material:
- the craft-follow time constant of 0.18 s
- bank angles in degrees
- whether any given orb is player or enemy fire
- the trigger for the red portrait tint (the shield at 39 in 07 shows a normal portrait)
- ring source (wingtrail versus kill)
- the ENEMY METRICS segment "mostly empty" (it is empty in 01-06 and 08, full in 07)

## 3. Checks against the [O] tags in the seeds
| Seed claim | Verdict | Evidence |
|---|---|---|
| ANALYSIS 5: HUD perimeter only | confirmed | All gameplay stills and frames. The craft tail and the smoke can pass under the bottom band (m3 f008-f011, 03). |
| ANALYSIS 5: right-edge ladder | confirmed | Green vertical line at x 97.5% of width, running 14-59% of frame height, with diamond end caps, green ticks and a white marker whose position varies. |
| ANALYSIS 5: portrait bottom-right with a view-key label | confirmed | Frame at x 83.7-94.3%, y 65.5-90% of 1080; border #02BE07. |
| ANALYSIS 5: reticle circle with ticks, offset from craft | confirmed | Main ring about 12.1% of frame height (131/1080), 14.2% including ticks, 12 ticks at 30 degree spacing, a centre "+", and a second thin circle 0.49x the size tangent inside it. The size is constant in every still. The offset direction relative to the craft varies (down-left in 01, up-left in 02/03, down-right in 04). |
| ANALYSIS 5: target lock red square brackets | confirmed + extended | #FB0200; multiple stacked brackets with diamonds (03, m1). |
| ANALYSIS 5: hazard striped border | **corrected** | Solid double rails that blink (08, m3 f012/f013). |
| ANALYSIS 6: HUD line green ≈ #2CA72F | **corrected** | #00B809 median line (core #00C20C) on dark space; bright HUD green #02FC03. |
| ANALYSIS 6: shield red ≈ #FF1C01 | confirmed | #FF1C01. |
| ANALYSIS 6: HUD green is the only green | partly | True in stills 01-08; the rings' green bands and RGB-split fringes also add green. |
| ANALYSIS 6: craft and hostile fire are the warmest objects in cool frames | confirmed | 02, 03, 04, m2; fails in 05. |
| DESIGN_SEED: craft trails reticle, 0.18 s | cannot verify | Only the offset is observable; its direction is inconsistent. |
| DESIGN_SEED: bank 60-70 deg (m3) | cannot verify | 2D only; screen wing line 35-40 degrees at t=0. |
| DESIGN_SEED: missile smoke > 2 s, thick, pale, curved | confirmed | m1 0-2.07 s, 03, 06. |
| DESIGN_SEED: ring 0.7-1.3 s, grows to 30-65% | **corrected** | Pops at 44-56%, grows under 5 points, lasts 0.15-0.25 s (short) or at least 0.5 s (long). |
| DESIGN_SEED: ring thickness 3% of radius, RGB offset 0.4-0.8% | **corrected** | Total band about 13-15% of radius; channel spacing about 5% of radius. |
| DESIGN_SEED: explosion core 1x to 3x in 0.3 s | **corrected** | About 2x in 0.3 s (clip starts mid-explosion). |
| DESIGN_SEED: enemy bullets white-hot core, dark outline | **corrected (as observation)** | The observed core is flat yellow #FEFE00 with an orange or pink halo and no dark outline. Our spec may keep the white core and outline as an upgrade, but it must be tagged [A]. |
| DESIGN_SEED: beam white core 0.6 m, red halo 3 m | **corrected** | Core about 65% of width, halo about 25% per side. |
| DESIGN_SEED: caltrop drone "four-point red star" | partly | Dark spiky bodies with glowing red-orange cores; they read as dark stars, not red ones. |
| DESIGN_SEED: strider red accents, centre | confirmed | m4. |
| DESIGN_SEED: chromatic aberration at edges | confirmed | Strongest at frame edges and on small debris (3-6 px split at 800 px). |
| STYLE_SEED 6: top band 6.5%, bottom 9% | **top corrected, bottom confirmed** | 8.5% / 9.1% (7.2% and 7.8% only at the inner chamfers). |
| STYLE_SEED 2: hud.text #75E845 | **corrected** | Primary text is white #FCFEFA; bright green #02FC03 for active fills and icons. |
| STYLE_SEED 4: wingtip fins/arcs | **corrected** | Crescent fins inboard at about 55% of the half-span. |

## 4. Measured values
**HUD geometry (1920x1080; frames agree within 0.3%)**

| Element | Value |
|---|---|
| Top band | Outer line at 0.5%. Lower border at **8.5%** (7.2% at the inner chamfer notches). Segment widths about 33% / 37% / 33% with overlapping chamfers. |
| Bottom band | Upper border at **9.1%** (7.8% at the diagonal joins). Bottom line at 99.5%. Bars 2.8-3% of frame height tall. |
| Band fill (new) | Inside both bands the background is multiplied by **0.68-0.73 (sRGB)**, which is black at about 30% opacity. Measured in 03, 04, 05 and 07; for example 04 bottom #929688 becomes #63665E and 04 top #0033A2 becomes #011C73. |
| Reticle | Ring 12.1% of frame height, 14.2% with ticks. Stroke about 4 px at 1080p. 12 ticks. Inner circle 6%. |
| Portrait | 10.6% of frame width x 24.5% of frame height; bottom edge at 90% of height. |
| Ladder | x = 97.5% of width, spanning 14-59% of height. |
| Glyphs | Primary glyph cap height about 1.9-2.3% of frame height, monoline, stroke about 0.2% of height. Corner labels about 0.75%. |

**HUD colours (03, over near-black space)**

| Element | Value |
|---|---|
| Line | #00B809 (core #00C20C) |
| Bright green (reticle, ladder, icons, chip fill) | #02FC03 / #00FD02 |
| Combo label | #06DD08 |
| Corner labels | #04B307 |
| White text | #FCFEFA |
| Shield | #FF1C01 |
| Lock bracket | #FB0200 |
| Chip text | #02570A |
| Hazard | Rails olive-yellow with bright yellow outlines; banner text yellow (08 crop) |

**Scene colours (region medians, cell = 1/16 width x 1/9 height)**

| Scene | Values |
|---|---|
| Cloudgate (01/04/07/m2/m4) | Sky just below the HUD #0939AF (01) / #0136B2 (04); mid sky #1695D5 / #0151CD; low sky cyan #15A0F1. Cloud lit side #F9FAED to #FDFAF9. Cloud shade #B4C2B2 to #D0D6C2 (04) or blue-tinted #85ACBE to #8DBBD2 (07). Fog sea #BCC4AF. Dark structure #1F3B48 to #2D424F (04), mid structure #778C96 (m4). Frame median luminance 22-38%, 95th percentile 82-92%. |
| Violet Tide (02) | Top #0C0D45; magenta #8E3A5A; pink glow #F57B96; sun #FEFEB2; horizon #F25413 / #F99720 / #FDF73F; cloud-sea tops #4C2738; lower field #060E20. Median luminance 2.3%. |
| Wreckfield (03/06/08/m1) | Void #010206 / #00050B; debris plane #0F353A / #081E25; nebula #073028 to #0C463E (06); smoke lit #DCCBAA; pale planet #F2DBA3 (06); light source #F9FBD7. Median luminance 1.1-3.7%. |
| Hot (05) | #FE8701 to #FE9E01, peaks #FEFEFD, lava #AE444C. |
| Craft | Hull warm light grey #A89A81 to #CDBAA8 (15/17); gameplay craft reads dark navy-charcoal under sky light (01, 03, m2); canopy #0A3785 to #2A447D; vent yellow #F8E210; exhaust core #FAFF0C / edge #E44506. |
| Boss (07) | #071024 against sky #086BA2. |

**Effects**

| Effect | Value |
|---|---|
| Orbs, dark background | Core #FEFE00, rim #F38407, halo #5E3A16. Core 1.9-3.3% of frame height, halo 3.5-5.3%, halo:core 1.6-1.9. Near camera up to 9.8%. |
| Orbs, blue sky | Core #FEFC07, rim #FDF9B8, halo #F59FD7. Core 3.6-5.3%, halo 7.9-10.9%. |
| Orbs, m4 | Grow from 2.4-2.7% to 5.6-6.7% of frame height over 1.27 s. |
| Explosion (m2) | Yellow #F9FF12, hot spots #FAFF7C, chunks #EA821A. Width 15% to 30% of frame width in 0.3 s. |
| Beam (06, right edge) | Upper halo 73 px, yellow line 5 px, core 197 px (core 65-70% of visible width). Core #FDFDFD, edge #FDF776, halo fades to #7B1C15. |
| Boss beams (07) | #FDFE06 with white core #FEFEF9; each 7-10% of frame width at the top edge. |
| Lasers | 04: #FD0102 with bloom #FDA5B7. m4: #DF2F3B, 6-9% of frame width wide near the bottom edge, tip speed about 1.5 frame widths per second. |
| Rings | Width: m1 55-56% (outer) / 52% (band centre); m4 #1 44%; m4 #2 48% growing to 53%; 08 49%; m2 post-cut 52%; m3 faint 51%. Aspect 0.55-0.6. Band order red (inner), green, blue (outer). Each band about 1-1.6% of frame width; total about 3.3-4.1% of frame width, about 13-15% of radius. |
| Smoke ribbons | 16-23% of frame height near the camera, about 6% far away. The thin missile trail in 02 is about 2%. |

**Timings (from frame names)**

| Clip | Events |
|---|---|
| m1 | No cut. Bloom 0.33-0.9 s. Kill 1.40 s. Ring at 1.67 s. |
| m2 | Cut between 0.80 and 0.87 s. |
| m3 | Whiteout 0.13-0.35 s. Label gone by 0.20 s. Cut between 0.73 and 0.80 s. Rails blink between 0.80 and 0.87 s. |
| m4 | No cut. Hit tint from 0.53 s. Ring #1 at 0.80-0.93 s. Lasers extend 1.33-1.6 s. Ring #2 from 1.53 s. |

**Craft framing (gameplay stills and frames)**

| Measure | Value |
|---|---|
| Centre positions | 36/37% (01), 65/76% (02), 53/67% (03), 36/25% (04), 71/25% (05), 72/72% (06), 66/20% (07), 70/63% (m2 f000), 17/80% (m3 end) |
| Size on screen | 12-20% of frame width typical, 30% of frame height at most |
| Placement | The craft is **not** held at bottom centre: 7 of 9 samples are more than 15% of frame width off centre. |

## 5. Corrections for DECISIONS.md

## 2026-09-30T05:39Z — Top HUD band height is 8.5%, not 6.5%
- **Seed said:** STYLE_SEED 6, "top band ~6.5% of frame height".
- **Refs show:** the lower border line is at y 91-92 of 1080 (8.5%) in 02, 03 and 09, and at 8.4% in the m1 frames. 7.2% occurs only at the chamfer notch. The bottom band (9.1%) is confirmed.
- **Recommended change:** top band 8.5%, bottom 9.1%. Tag both [O].

## 2026-09-30T05:39Z — HUD bands carry a 30% black scrim
- **Seed said:** not specified; the HUD was treated as line-only.
- **Refs show:** the background inside both bands is multiplied by 0.68-0.73 (5 stills).
- **Recommended change:** add token `hud.scrim = rgba(0,0,0,0.30)` [O]. Primary text is not bloomed.

## 2026-09-30T05:39Z — HUD colours: lines #00B809, bright #02FC03, primary text white
- **Seed said:** hud.line #2CA72F [O]; hud.text #75E845.
- **Refs show:** line #00B809 (core #00C20C); active fills and icons #02FC03; primary labels and values #FCFEFA white; only the combo label and the corner labels are green.
- **Recommended change:** set `hud.line #00B80A`, `hud.bright #02FC03`, and add `hud.text #FCFEFA`. The seed's yellow-green is not observed. We may still choose a slightly different green for originality; if so, tag it [A].

## 2026-09-30T05:39Z — Hazard HUD state is blinking solid yellow rails, not stripes
- **Seed said:** ANALYSIS 5 and STYLE_SEED 6, "yellow/black striped" border.
- **Refs show:** two solid olive-yellow rails with bright outlines follow the top-band chamfers at 9-13% of frame height, plus yellow tabs on the top edge and a banner at about 14% of frame height. The rails blink (on at m3 0.80 s, off at 0.87 s) while the banner persists.
- **Recommended change:** decide deliberately. Either rails that blink at about 4 Hz [O], or keep diagonal stripes as our own original variant [A]. Stripes do follow our "hazards = striped" shape rule, so keeping them is defensible, but they must no longer be tagged [O].

## 2026-09-30T05:39Z — Shock ring pops at full size; it does not grow from 30% to 65%
- **Seed said:** DESIGN_SEED, "grows 0.7-1.3 s to 30-65% of screen width"; thickness 3% of radius; RGB offset 0.4-0.8% of radius.
- **Refs show:** rings appear within one frame at 44-56% of frame width (aspect 0.55-0.6) and grow by at most 5 points. Short rings last 0.15-0.25 s (m4 #1); long ones last at least 0.5 s (m1, m4 #2, still visible at clip end). The ring is three separated bands (red inner, green, blue outer); the band totals 13-15% of the radius with about 5% channel spacing.
- **Recommended change:** ring = scale ease-out from 0.85 to 1.0 of the final size over 0.1 s, then growth of at most +10% while fading. Final width 45-55% of frame width [O]. Band thickness 14% of radius, channel offset 5% of radius [O]. Lifetime 0.2 s for a hit ring and 0.6 s for the wingtrail ring [A].

## 2026-09-30T05:39Z — Explosion grows about 2x in 0.3 s, not 3x; debris is angular orange chunks
- **Seed said:** DESIGN_SEED, "core sphere 1x -> 3x in 0.3 s".
- **Refs show:** in m2 the width goes from 15% to 30% of frame width between 0.00 and 0.30 s (the clip starts mid-explosion). Colours: #F9FF12 lemon mass, #FAFF7C hot spots, #EA821A angular chunks.
- **Recommended change:** 1x to 2x [O] (up to 3x from ignition, [A]); add 6-12 angular chunk sprites.

## 2026-09-30T05:39Z — Observed bullets have a flat yellow core and no dark outline; minimum size 0.9% is too small
- **Seed said:** DESIGN_SEED "Enemy bullets | white-hot core ... O"; STYLE_SEED 7 minimum 0.9% of frame height.
- **Refs show:** core #FEFE00, rim #F38407, halo 1.6-2.1x the core (orange on dark, pink #F59FD7 on blue). Core diameter 1.9-5.3% of frame height at mid-range. No dark outline.
- **Recommended change:** keep white-hot core plus dark outline as our readability upgrade, but tag it [A]. **Raise the minimum core to 1.8% of frame height and the halo to 3.5%.**

## 2026-09-30T05:39Z — Beam proportions: broad white core, thin halo
- **Seed said:** DESIGN_SEED, "white core 0.6 m + red halo 3 m" [O].
- **Refs show:** at the right edge of 06 the core is 65-70% of visible beam width, with a 5 px yellow edge line and a halo of about 25% per side fading #F84C28 to #7B1C15.
- **Recommended change:** core : halo per side = 2.6 : 1 [O], plus a yellow edge line.

## 2026-09-30T05:39Z — Craft fins are inboard crescents, not wingtip arcs; reference craft is larger than 9 m
- **Seed said:** STYLE_SEED 4, "wingtip fins/arcs"; wingspan about 9 m [A].
- **Refs show:** 18 has crescent fins at about 55% of the half-span, about 38% of span tall, with wing extending beyond them. Pilot-to-span ratio is about 1:12.8 in 18, and the canopy is about 2.7 pilot heights in 15.
- **Recommended change:** move the fins inboard [O]. Keep 9 m as a design choice [A], or scale to 16-20 m if we want the reference's proportions.

## 2026-09-30T05:39Z — Combat text: the red label exits, it does not turn green
- **Seed said:** ANALYSIS 7 m3.
- **Refs show:** the red event label slides left and is gone within 0.2 s; the green hits/seconds counter persists and counts up in real time.
- **Recommended change:** HUD spec: event label lasts 0.2 s with a slide-out; the counter persists.

## 2026-09-30T05:39Z — m4 motion claims corrected
- **Seed said:** lasers sweep in from the bottom corners; three bullets rise; ring #1 is about 30% wide; ring #2 reaches 65%.
- **Refs show:** lasers extend outward from the strider at about 1.5 frame widths per second. The bullets descend and grow (they are incoming). Ring #1 is 44%, ring #2 is 48-53%.
- **Recommended change:** DESIGN_SEED sniper/strider laser "extend phase 0.25 s" [O]. Strider enemy hit flash = red-orange full-body tint lasting 0.3 s in the reference; our white 2-frame flash stays [A] as the upgrade.

## 2026-09-30T05:39Z — Drift camera holds while the craft travels
- **Seed said:** m2 "camera holds steady behind it".
- **Refs show:** during a drift the craft moves about 57% of frame width and yaws about 150 degrees to side-on within 0.8 s, while the view does not follow it (m2, m3).
- **Recommended change:** drift camera = look-at blend at most 30%, letting the craft slide up to ±30% of frame width off its rest position [A, based on O].

## 2026-09-30T05:39Z — Tags that can become [O]
- `camera rolls with craft`: slight roll is observed in m1 and m4, but the 30% figure stays [A].
- Chromatic aberration at the edges: [O] confirmed.
- Missile smoke persistence of at least 2 s: [O] confirmed.
- The boss-health HUD bar in the top-right segment: newly observed, [O].

## 6. New observations the seed missed
1. **Craft framing.** The gameplay craft is rarely at bottom centre. Centres range from 17% to 72% x and 20% to 80% y. The craft is 12-20% of frame width. Its tail may pass under the bottom HUD band.
2. **The sunset stage is dark.** Median luminance is 2.3%, and all brightness sits in one horizontal band about 35-45% of frame height.
3. **Cloud whiteout.** Flying through cloud blanks the frame to near-white for 0.2 s (m3). The HUD stays readable because of the scrim.
4. **Whiteout versus threats.** Nothing hostile appears during the whiteout. This is a readability rule we should adopt: no hostile fire during a whiteout.
5. **Glyphs.** Primary text is monoline angular white glyphs with cap height about 2% of frame height. Small labels are bold green caps at 0.75%.
6. **Portrait behaviour.** The portrait turns red monochrome on damage and shows short TV-static or scan-bar glitches (about 1-2 frames).
7. **Floating feedback.** A green "+shield" pop sits beside the reticle while a combo refill runs (m4). A green "+N missiles" pop sits beside the locks (03).
8. **Progress bar flash.** The progress-bar fill flashes white on score events (m1 f023, m2).
9. **Speed streaks.** Speed streaks are dense only at the frame edges. The inner 50% of the frame stays clear (08, m1 f016+).
10. **Two families of warm projectiles.**
    - Round flat-yellow orbs, low-poly with visible polygon edges.
    - Thin orange tracer lines.
    - Hostile lasers are red, never yellow.
11. **Halo hue shifts with background.** The same orb halo reads orange on space and pink on blue sky.
12. **Scale and haze.** Hull structures are mid-grey in haze (m4) and dark slate when closer (04). Distance haze is strong: about 50% value lift over the corridor depth.
13. **Emissive colour discipline.** Emissive vents and inserts are yellow stripes inside red-orange frames on the craft, the boss and the hangar. That is a consistent language.
14. **Cel-flat shading.** Orbs and explosion blobs are flat fills with polygonal outlines (no gradients). This fits procedural low-poly work.
15. **HUD over bright yellow.** Green lines lose contrast over yellow beams (07). The scrim keeps white text readable, but the corner labels vanish in 05.
