# DESIGN SEED — numbers (tune in playtest)

Tags: **[O]** observed in supplied material, **[R]** reported by reviews, **[A]** assumption. Anything [A] must be tuned by scripted playtests and Reviewer feedback; log every change of a number in `Docs/DECISIONS.md`.

## Camera and rail
| Item | Value | Tag |
|---|---|---|
| Camera | third person chase, 9 m behind, 2.6 m above the craft, FOV 68 deg | A |
| Craft vs aim point | craft trails the reticle with time constant 0.18 s | O (craft offset from reticle in frames) |
| Rail speed | 45 m/s baseline, boost x1.6, brake x0.5 | A |
| Movement window | +/-16 m horizontal, +/-9 m vertical around the rail; max lateral speed 22 m/s | A |
| Roll follow | craft banks up to 65 deg into turns; camera rolls 30% of craft bank | O (bank 60-70 deg in m3), A |
| Stage length | ~180 s (8100 m at baseline) | A |
| Cockpit camera | P2: first-person toggle | R |

## Weapons and specials
| Item | Value | Tag |
|---|---|---|
| Cannon | held fire, 14 shots/s, 1 damage, projectile 260 m/s, range 220 m | A (default cannon R) |
| Lock-on missiles | hold to sweep, up to 8 locks, 0.10 s per lock while reticle within 60 px of target, release to fire, missile 110 m/s, turn rate 240 deg/s, 6 damage, ammo 6 (upgradable), +1 ammo per 12 s | R (mechanic), A (numbers) |
| Missile smoke | pale ribbon, life 5 s, width 0.8 m -> 3.0 m, 30 puffs/s, bends with camera | O (>2 s persistence, thick pale, curved) |
| Boost | 0.7 s, x1.6 speed, deflects projectiles in a forward cone, then 0.5 s exposed (damage x1.25), cooldown 5 s | R |
| Brake | hold; speed x0.5; pickup magnet radius 35 m; damage taken x1.3 | R |
| Barrel roll (parry) | 0.45 s roll, parry window first 0.20 s: negates the hit, reflects bullets, +1 combo, +3 shield. **Fix for spam:** 3 roll charges, 2 s recharge each, and an unsuccessful roll has 0.25 s recovery | R, A |
| Drift | up to 1.4 s, world time scale 0.35 (combo timer decays at 0.35x), 35% steering authority; exhaust capsule (radius 3 m, length 14 m) deals 4 damage per tick at 15 Hz; recharge 9 s | R (mechanic), A |
| Wingtrail | 360 deg spin over 0.9 s, time scale 0.5, shock ring 0 -> 45 m over 0.7 s, 8 damage to small enemies, 30 to boss weak points, charges every 40 kills or 14 s | R, O (ring 0.7-1.3 s), A |
| Vortex | P2: absorbs bullets in a 20 m sphere, exposed after | R |

## Health, combo, scoring
| Item | Value | Tag |
|---|---|---|
| Shield | 100 max; no passive regen | A |
| Combo window | 2.0 s, each kill +0.6 s (cap 3.0 s) | A |
| Combo shield refill | >= 4 kills in a chain: +5 shield/s while the combo is alive | R |
| Damage | bullet 6, collision 25, laser 18/s (telegraphed 0.7 s), boss beam 30/s | A |
| Post-hit invulnerability | 0.6 s (reviewers found the original too short) | R, A |
| Score | base value x multiplier (1 + 0.1 x chain, cap x5); parry +50; stage bonus = shield left x 10 + time bonus | A |
| Rank | S/A/B/C by score fraction of a designed par (0.9/0.7/0.5) | A |
| Difficulty | 3 levels in Slice (enemy HP and fire rate x0.8 / 1.0 / 1.3) | R (5 in original), A |

## Enemies (silhouette families: stars, wedges, orbs, bipeds)
| Enemy | HP | Behaviour | Value | Tag |
|---|---|---|---|---|
| Caltrop drone (four-point red star, 1.4 m) | 3 | chains of 8-14 on curving paths, contact damage 10, no shots | 100 | O (m2), A |
| Dart fighter (dark wedge, orange thrusters) | 6 | pairs; 3-shot bursts of orb bullets (60 m/s) every 1.6 s | 200 | O, A |
| Laser sniper | 10 | 0.7 s thin telegraph line, then 0.4 s beam | 400 | R, A |
| Strider (bipedal mech, red accents, jetpack) | 60 | hovers centre; 5-orb spread every 2.2 s (45 m/s) plus diagonal laser sweeps; weak point on the back | 1500 | O (m4), R (less spongy), A |
| Bulwark (capital boss) | 3 phases: 600/800/1000 | phase 1 beam volleys, phase 2 adds drone waves and vent barrages, phase 3 sweeping wall of beams; recovery windows between volleys | 10000 | O (S07), R, A |

## Stage pacing template (Cloudgate, ~180 s; adapt for others)
| t (s) | Content |
|---|---|
| 0-15 | launch, 8 drones in a chain, tutorial prompts fade |
| 15-40 | dart fighter pairs; first laser telegraph |
| 40-70 | snipers + drone chains; hull structure alongside |
| 70-100 | breather corridor, pickups, then denser drones |
| 100-140 | strider trio mini-boss |
| 140-170 | gauntlet, all families, peak density |
| 170-180 | clear bonus, results |
Peak density target: 60-90 live hostile projectiles and 25-40 live enemies (perf budget must hold here).

## Modes
- Campaign slice: 3 stages (P0 stage 1). Caravan: 120 s, wave loop at x1.4 density, no shield regen except combo, score attack (P1). Roguelite one-life with pickups (P2).

## Feedback and juice
| Item | Value | Tag |
|---|---|---|
| Hit-stop | 40 ms on missile impact, 60 ms on boss weak point | A |
| Screen shake | max 0.15 m, 0.35 s decay | A |
| Enemy hit flash | white for 2 frames + damage pop | A (fixes hit clarity complaint) |
| Chromatic aberration | 0.0015 UV baseline, pulse to 0.006 on hits, 0.008 during shock rings | O (edge fringing), A |
| Scanlines / grain | 540 lines at 0.06 opacity, grain 0.04 | R (VHS scanlines, film static), A |
| Bloom / vignette | threshold 0.85, strength 0.6 / vignette 0.25 | A |

## VFX numbers
| Effect | Recipe | Tag |
|---|---|---|
| Explosion | core sphere 1x -> 3x in 0.3 s, yellow-white (#F9EF00) to orange (#E16C26); 6-10 lobes offset radially; 20-40 sparks | O (m2) |
| Shock ring | thin ellipse (thickness 3% of radius) in the screen-facing plane, RGB offset 0.4-0.8% of radius, grows 0.7-1.3 s to 30-65% of screen width, fades over the last 30% | O (m1, m4) |
| Speed streaks | ~200 radial lines from the vanishing point, length proportional to speed, brighter at frame edges | O |
| Beam | white core 0.6 m + red halo 3 m; **telegraph line first** | O (S06), A |
| Enemy bullets | white-hot core, yellow-orange halo, thin dark outline ring, >= 0.9% of frame height at 60 m | O (yellow-orange orbs), A |

## Audio (procedural)
- Synth-rock feel: 140 BPM, minor key, four intensity layers (bass pulse, arpeggio, pad, noise percussion) driven by combo/danger. [A]
- SFX list: cannon tick, missile launch/lock tone, missile impact, explosion (layered), parry chime, roll whoosh, drift whine, wingtrail sweep, shield refill rise, warning klaxon, UI click, boss beam charge.
- Verify with `npm run audiocheck`; label pending owner review.
