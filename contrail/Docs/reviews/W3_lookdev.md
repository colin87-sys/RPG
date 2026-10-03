# W3 Look-Dev review (fresh Reviewer)

Date: 2026-09-30. Reviewer: fresh-context agent. Inputs: GAME_FORGE.md section 12 (rubric), Docs/STYLE_BIBLE.md, Docs/PRINCIPLES.md, Docs/REF_VERIFICATION.md, owner refs 01, 02 and 04 (compared by relationship only), and all 45 candidate boards in `look/candidates/`. I opened every board. None failed to open, so no zero scores. No author explanations were read. The `.json` params were consulted only to name concrete fixes.

Look keywords graded: (1) bright-to-dark drama, (2) readable spectacle, (3) thin-perimeter HUD with open centre.

Status of every selection: **pending owner review**.

---

## 1. Paired comparisons per subject

### hero (KESTREL)
- **A vs B → B.** Same silhouette. B's steel-dominant armour (#52687A mid panels, light trim) separates from the near-white horizon in the CHASE 1:1 crop. A's near-white hull melts into the pale lower sky (left wing tip and fins at the bottom of the crop). B's extra orange wing grilles give the warm accent the bible asks for.
- **B vs C → B.** C has no outline (outline 0 tris), so its edges soften against the sky in FRONT and CHASE. Its longer nose and 44 degree sweep read more generic-jet, and its fins are shorter. B keeps the crisp outline and the 52 degree delta.
- **A vs C → A.** Same light livery, but A keeps the outline, and its silhouette-top reads sharper as a delta.
- **Ranking: B, A, C.** Caveat for all three: the fins sit at the wingtips (the bible says "wingtip fins/arcs", REF_VERIFICATION 018 says inboard at 40-60% of half-span). The hull is cool white/blue-grey rather than the warm light grey in PRINCIPLES 14, so the canopy is not the only cool accent.

### enemies (WARDEN line-up)
- **A vs B → B.** B ("Hard panel") shows seams and panel breakup on the strider and dart (DART 7 m pair, STRIDER back), and its 1.4 px outline matches the hero's outline. A has no outline and softer, seamless bodies.
- **B vs C → B.** C ("Ink") has the strongest warm rim (the dart pair shows a crisp orange edge line), but seamStrength 0 gives flat ink bodies. That hits the PRINCIPLES rejected look "every mesh has panel seams". B is the better hard-surface sibling of the hero.
- **A vs C → C.** C's outline and stronger rim separate the silhouettes better on the cream tiles than A's soft rim does.
- **Ranking: B, C, A.** Shared problems: on the space tiles the dart and strider are brown-on-navy and nearly vanish. In "TRUE SCALE vs BULWARK" the boss is salmon-pink and bright, not the near-black boss mass seen in the refs.

### vista-cloudgate
- **A vs B → B.** A's sparse towers leave the frame flat: one tower, a huge empty fog sea and weak depth. B adds mid-distance banks and a near left cloud mass, so there are three layers.
- **B vs C → C.** C has the most parallax (near left mass, mid towers left and right, far banks) and frames a corridor with the centre still open above the craft. B's big grey left cloud reads overcast.
- **A vs C → C.**
- **Ranking: C, B, A.** In all three, the bottom ~45% is a pale cream-grey fog sea with little contrast, and the cloud undersides are muddy blue-grey. The vista also lacks the dark side mass that gives ref 04 its bright-to-dark drama.

### vista-violet
- **A vs B → A.** B's sun is the largest white disc, at frame centre, exactly where the reticle and targets live, and its glow washes the upper-centre sky.
- **B vs C → C.** C has the smallest sun and the darkest indigo zenith, with a wider orange horizon band. That is closest to the ref relationship (dark frame, one narrow bright band).
- **A vs C → C.**
- **Ranking: C, A, B.** All three fail keyword 1. The whole frame is mid-value mauve/pink, and the cloud sea is pink rather than plum to navy-black. The ref median luminance is 2-5%. These boards look roughly 30%+.

### vista-wreck
- **A vs B → A.** B has the most clutter (100 asteroids, 6000 flecks), and mid-field debris crowds the centre where threats must read.
- **B vs C → C.** C has big near-dark rock masses at left and bottom-left (near layer), a mid cluster and a larger, stronger planet key (far). That gives the clearest 3-layer depth and the cleanest centre.
- **A vs C → C.**
- **Ranking: C, A, B.** Flat-shaded low-poly rocks look default. The placeholder craft is lit fully yellow on its underside, which contradicts "rim-lit by the planet".

### structures (Cloudgate hull mass)
- **A vs B → B.** B's two rings form a real "gate" that frames the corridor, and its denser greebles and marker lights give scale. A has one ring and a plainer hull.
- **B vs C → B.** C's outer ring is a heavy dark band across the upper-left sky. B's rings are thinner and read as architecture.
- **A vs C → C.** C has more framing than A.
- **Ranking: B, C, A.** In all three, the hull is mid slate grey (roughly 30-40% luminance) with a cool flat tint. That reads as a default-material look and fails PRINCIPLES 16 (dark side mass under 6%).

### hud
- **A vs B → A.** A's italic angular glyphs match "angular techno". B's upright thin glyphs look generic and lose weight over the bright sky (bottom-band "RIVETER", "72/100").
- **B vs C → C.**
- **A vs C → C.** C's bolder italic glyphs have a dark outline, so white values and red "PARRY +50" hold contrast over cream clouds.
- **Ranking: C, A, B.** Layout is identical in all three: perimeter bands, open centre, right ladder, pilot frame bottom-right.

### hud-states
- **A vs B → A.** In the normal/bright tile, B's thin text washes out (bottom band nearly illegible).
- **B vs C → C.**
- **A vs C → C.** C's outlined glyphs stay readable in all four states. Hazard rails and banner, and the red pilot frame in danger, read at thumbnail size.
- **Ranking: C, A, B.** Hazard is a single striped border, not the blinking double rail from REF_VERIFICATION. PRINCIPLES 11 allows stripes, so that is acceptable. The danger state tints only the pilot-frame border, not the whole portrait.

### screens
- **A vs B → A.** A has the same italic family as the preferred HUD. B's upright type is weaker on the title.
- **B vs C → C.**
- **A vs C → C.** C's bold italic title and "SIGNAL LOST" have the most punch and match HUD C.
- **Ranking: C, A, B.** The board label "STAGE CARD + NEW UPGRADE" overlaps the score readout. The title's neon floor grid leans toward the rejected "neon-only" look. Keep it subtle.

### post
- **A vs B → A.** B (grain 0.025, scanline 0.04) is nearly indistinguishable from the clean pass, so the analogue character is lost. A shows light grain and scanlines, and the orb rims stay crisp at 1:1.
- **B vs C → B.** C (grain 0.05 at size 1.5, softness 0.6, vignette 0.3) visibly speckles the sky and craft in "1:1 craft, full stack" and darkens the corners behind the HUD. That violates "thick post effects that hide the craft".
- **A vs C → A.**
- **Ranking: A, B, C.** In every variant the "+vignette/grade" step pulls the sky toward beige-grey and costs bright-to-dark range. Speed streaks are barely visible in panel 6.

### vfx-ring
- **A vs B → A.** A shows exactly three separated bands (red inside, green, blue outside), matching PRINCIPLES 22 and ref 08. B's tighter spacing produces a doubled pink-green-red look (5 apparent bands) that shimmers.
- **B vs C → C.** C's continuous spectral rainbow is at least clean, but it turns pastel and weak on the bright sky (1:1 crop).
- **A vs C → A.** A reads on both the bright-sky and space backdrops.
- **Ranking: A, C, B.** All three grow from about 20% to about 48% of frame width across 0.55 s. PRINCIPLES 21 wants a pop at 85% of final size and then a hold.

### vfx-beam
- **A vs B → A.** B's 42% core is the furthest from the ~65% spec. A is 48%.
- **B vs C → C.** C's 55% core is closest to spec, and its fire-flash frame shows the strongest extension from the emitter.
- **A vs C → C.**
- **Ranking: C, A, B.** On the bright sky, the laser's white core sits on cream cloud and only the thin red halo separates it (1:1 fire crop). The yellow edge line is barely visible.

### vfx-bullets
- **A vs B → B.** B has a 2.0% core floor (meets PRINCIPLES 2's 1.8%) and the thickest dark outline ring. Its Cloudgate dE of 33 beats A's 31.
- **B vs C → B.** C has no dark ring (soft halo only), and Cloudgate p10 dE is 14. Orbs in the cream-cloud crop are the faintest.
- **A vs C → A.**
- **Ranking: B, A, C.** Player fire (thin cyan streaks) is clearly a different family, which is good.

### vfx-smoke
- **A vs B → B.** B ("cumulus") shows lit-top and grey-underside self-shading, so its ribbons keep an edge against Cloudgate puffs at t=2.5 s. A's smoother rope is flatter.
- **B vs C → B.** C ("wisp") is warm and translucent, and its overlapping sprite discs are visible as circles (t=2.5-3.5 s Wreckfield). It is the weakest on cloud.
- **A vs C → A.**
- **Ranking: B, A, C.** All three persist to 4.8 s (meets the 5 s target). On Cloudgate, every variant's smoke is the same value as the clouds.

### vfx-explosion
- **A vs B → A.** B ("hot-white") stays a white blob from 0.03 to 0.3 s, and on the bright sky it merges into the cream clouds. A goes white core, then yellow, then orange lobes with sparks and small blooms, exactly per the bible.
- **B vs C → C.** C keeps a readable shape but loses the white core and turns pink-red on the bright sky.
- **A vs C → A.**
- **Ranking: A, C, B.** The backdrop clouds on the explosion and smoke boards are lumpy, stone-textured puffs, a different cloud language from the soft cumulus of vista-cloudgate.

---

## 2. Winners

| Subject | Winner | One-line reason |
|---|---|---|
| hero | B | Steel-dominant hull separates from the bright horizon, and it keeps the outline and delta silhouette |
| enemies | B | Seams, outline and panel breakup match the hero; readable silhouettes |
| vista-cloudgate | C | Most depth layers, with a framed corridor and an open centre |
| vista-violet | C | Darkest zenith and smallest sun; closest to the dark-frame relationship (still too bright) |
| vista-wreck | C | Clear near/mid/far layers, strongest planet key, clean centre |
| structures | B | Double ring forms a gate that frames the corridor |
| hud | C | Outlined bold italic glyphs hold contrast on bright sky |
| hud-states | C | All four states legible; hazard and danger read at a glance |
| screens | C | Same type family as HUD C; strongest title |
| post | A | Visible analogue texture without hiding the craft |
| vfx-ring | A | Exact three separated R/G/B bands |
| vfx-beam | C | Core 55%, nearest the 65% spec; clearest extension flash |
| vfx-bullets | B | 2.0% core plus dark outline ring; best contrast on cloud |
| vfx-smoke | B | Self-shaded puffs hold an edge against clouds |
| vfx-explosion | A | White core, then yellow, then orange lobes, blooms and sparks, per the bible |

## 3. Consistency check across winners

Consistent:
- **Wreckfield key light.** The upper-right yellow planet appears in vista-wreck C and the ring, beam and bullet backdrops.
- **Threat language.** Beam C, bullets B and explosion A all use a white-hot core, warm halo and dark outline.
- **Type family.** HUD C, hud-states C and screens C share one glyph set and token set.
- **Outlines.** Hero B and enemies B both have outlines on, at similar weight.

Conflicts and fixes:
1. **Violet Tide has two different stages.**
   - vista-violet C is a mid-value mauve/pink frame.
   - The Violet backdrops in hud-states, screens and vfx-bullets are dark indigo with a narrow orange horizon, which is the correct relationship.
   - Fix: re-tune vista-violet C to the darker backdrop.
     - zenith and upper sky → sunsetZenith #1B1745 / sunsetIndigo #2A1F5A
     - cloud-sea tops → sunsetCloudDark #1E1030, with magenta #B24A9C only on rims facing the sun
     - cut the haze/fog luminance by about 60%
     - shrink the sun glow radius
   - Target frame median luminance is under 6%.
2. **Two cloud languages in Cloudgate.** The vfx-smoke and vfx-explosion backdrops use lumpy, bump-shaded stone-like puffs, while vista-cloudgate C has soft cumulus. Fix: render the VFX boards on the vista-cloudgate C rig so every lab board shares one cloud generator.
3. **Structure value against the rest of Cloudgate.** Structures B's hull is mid slate grey, lighter than the dark enemies and far from the near-black side mass the bible asks for. Fix:
   - drop the hull albedo toward armourDark #1C252D (or the #1F3B48 ref range)
   - let fog lift only the far end
   - add accentOrange vent inserts so it is not default grey
4. **Detail density.** Structures B (809 marker lights, dense greebles) out-details hero B (~1000 hull tris, sparse seams). Fix: keep B's ring geometry but use C's light count (~256) and greeble density on the hull.
5. **Cloudgate key direction is not demonstrated on hero/enemy boards.** Hero B's chase crop and enemies B's line-up use a generic top light. Fix: re-render both under the Cloudgate rig (high-left sun) and the Wreckfield rig (planet rim, upper right).
6. **Smoke value equals cloud value.** Smoke B's cream matches cloudCream, so on Cloudgate the ribbons merge into the vista. Fix: push the smoke underside to smokeShadow #98A2AE and keep smoke 1-2 value steps darker than the lit cloud, or add the ref's thin red/cyan edge fringing.
7. **Boss mass.** The Bulwark (enemies B, true-scale front) is salmon and bright. Fix: body to bossBody #141A22 with the warm rim limited to edges, so it matches the dark-enemy rule and the bright-to-dark drama.

## 4. Gate-style scores (winning set)

| Axis | Score | Evidence |
|---|---|---|
| 1. Style-bible match (replaces board match) | 6 | Tokens, delta hero, star/wedge/biped enemies and perimeter HUD follow the bible, but Violet Tide is mid-value mauve instead of a dark frame, and the Cloudgate hull is default-looking grey instead of a dark mass. |
| 2. Readability | 7 | Bullets B (dark ring, 2% core), square lock brackets and distinct enemy silhouettes read well, but dark enemies vanish on space tiles, and the white laser core and cream smoke merge with cream cloud. |
| 3. Lighting and colour harmony | 6 | Wreckfield is coherent (single planet key, closed warm/teal palette), but Violet Tide is washed out, the structure hull reads as untinted grey, and the grade pass pulls the Cloudgate sky toward beige. |
| 4. Depth and composition | 6 | Wreck C has three clear layers and structures B frames the corridor, but the Cloudgate vista's lower 45% is a flat pale fog sea with no dark side mass. |
| 6. UI clarity and polish | 7 | Thin perimeter bands, open centre and consistent tokens and glyphs (HUD C), but the bottom-band scrim is pale over bright sky, so white values and the tiny green corner labels lose contrast. |

**Average 6.4. Gate: not passed** (the average must be at least 7; no axis is below 5). Fixing D-1, D-2 and D-4 should lift axes 1, 3 and 4.

## 5. Top 5 defects (ranked by visual impact)

### D-1 — Violet Tide is a mid-value mauve frame, not a dark sunset   [impact: high]
Capture: look/candidates/vista-violet_C.png
Expected: Bright-to-dark drama. A dark frame (median luminance under 6%) with an indigo upper sky, a plum to navy-black cloud sea, one narrow bright band (sun plus horizon), and a warm-lit craft as the second-brightest object.
Actual: The whole frame is mid-value purple and pink, and the cloud sea is pink-mauve. The sun's white disc and glow sit at frame centre, where the reticle and targets live. It also disagrees with the dark Violet backdrops on hud-states, screens and vfx-bullets.
Suggested fix:
- zenith → sunsetZenith #1B1745
- cloud tops → sunsetCloudDark #1E1030, with magenta rims facing the sun only
- cut fog/haze luminance by about 60%
- halve the sun glow radius and move the sun off centre (about 60-65% x)
- verify the frame median luminance is under 6%
Owner lane: world

### D-2 — Cloudgate hull mass reads as default grey, not a dark side mass   [impact: high]
Capture: look/candidates/structures_B.png
Expected: One dark side mass under 6% luminance covering 20-35% of the frame beside fog above 45%, with palette-token panels and no default-grey look.
Actual: The hull is uniform mid slate blue-grey (roughly 30-40% luminance) with no warm accents. The "in context" frame reads as untextured metal, and its value sits close to the sky gradient.
Suggested fix:
- hull albedo → armourDark #1C252D / #1F3B48
- key from high-left to give cream edge highlights only
- aerial perspective to fog only at the far end
- add accentOrange vent strips
- keep B's two rings
- cut marker lights to about 256
Owner lane: world

### D-3 — Dark enemies disappear on space backdrops   [impact: med]
Capture: look/candidates/enemies_B.png (READABILITY strip, "DART space", "STRIDER space")
Expected: Enemies are dark with a warm rim at least 20% brighter than the body, separable on every stage background.
Actual: The dart and strider are brown-on-navy with a faint rim, and at a glance they are almost invisible. The caltrop only reads because of its red body.
Suggested fix:
- enemies B: raise stageRim for Wreckfield 0.25 → 0.6
- raise rimStrength 0.95 → about 1.5 (toward C's 1.7), keeping B's seams and outline
- raise markerIntensity for the space rig
Owner lane: entities

### D-4 — Cloudgate lower half is a flat pale fog sea   [impact: med]
Capture: look/candidates/vista-cloudgate_C.png
Expected: Near-white lit clouds with cool blue-violet shadows, sky as the 60% dominant field, and a dark side mass for bright-to-dark range (ref 04 relationship).
Actual: About 45% of the frame below the horizon is low-contrast cream-grey haze. Cloud undersides are muddy grey-blue. The craft rest position sits on this whiteout-prone area.
Suggested fix:
- lower the cloud-sea plane or raise the camera pitch so sky and towers dominate
- deepen cloudShadow #7F93AE toward blue-violet
- add ripple shading to the sea
- composite structures B (after the D-2 fix) at the right third of the vista board
Owner lane: world

### D-5 — HUD bands lose contrast over bright sky   [impact: med]
Capture: look/candidates/hud_C.png (bottom band) and look/candidates/hud-states_C.png (normal/bright tile)
Expected: Black 30% scrim under both bands, and white primary text at least 4.5:1 over a 92%-luminance sky (PRINCIPLES 27).
Actual: The band fill is a pale translucent grey-green. "72/100", "RIVETER" and "SHLD" and the 0.75% green corner labels sit on near-white cloud with weak contrast. The outline on C's glyphs helps, but not enough.
Suggested fix:
- band scrim → hudBacking #071C24 at 30-40% opacity
- keep C's glyph outline
- raise the corner-label weight or give each label a solid tab (as on SYS.STAT)
Owner lane: ui

Further defects (lower impact):
- **Ring grows instead of popping** (vfx-ring_A, t=0 → 0.55). PRINCIPLES 21 wants 85% of final size at spawn. Owner lane: vfx.
- **Laser white core on cream cloud** (vfx-beam_C, 1:1 fire crop). Widen the red halo or add the dark outline on bright backgrounds. Owner lane: vfx.
- **Hero hull is cool white** (hero_B). PRINCIPLES 14 wants warm light grey, with the canopy as the only cool accent. Owner lane: entities.
- **Grade step greys the sky** (post_A, panel 5). Owner lane: post.
