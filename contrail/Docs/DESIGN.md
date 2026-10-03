# DESIGN — numbers (single source in code: `src/data/tuning.ts`, `src/game/enemies.ts` ENEMY_DEFS)

## Current values that supersede the seed tables below (see Docs/DECISIONS.md)
| Item | Seed | Current | Why |
|---|---|---|---|
| Chase camera | 9 m behind, 2.6 m up | **20 m behind, 5 m up**, FOV 68 | refs show craft at 15-20% of frame width |
| Player hit radius | (unspecified) | **2.4 m** (bullets test 75%: 1.8 m) | zero hits at 1.4 m |
| Caltrop drone | HP 3, r ~0.7 | HP 3, **hit r 1.8 m, drawn x1.7** | readability |
| Dart fighter | HP 6, bursts every 1.6 s | **HP 10, hit r 3.0 m, drawn x1.3; single aimed shots on approach every 1.1 s (u<190 m); 3-shot fanned bursts every 1.6 s**, 80% lead | cannon killed darts before they fired |
| Strider | 5-orb spread every 2.2 s | **7-orb spread every 1.7 s**, 50% lead | density target |
| Hostile bullet size | >= 0.9% frame height | **core >= 1.8-2.0%**, halo ~3.7% | refs measured 1.9-5.3% |
| Explosion core growth | 1x -> 3x in 0.3 s | **~2x in 0.3 s** [O] | REF_VERIFICATION |
| Shock ring | thickness 3% of radius | **3 bands, ~13% of radius total**, still grows | REF_VERIFICATION + originality |
| Missile smoke emission | 30 puffs/s | **every ~0.62 m (110-180/s), 30/s floor** | gaps at 110 m/s |
| Stage | Cloudgate only defined in code (`src/game/stages.ts`) | Violet Tide, Wreckfield, BULWARK phases, Caravan: to be specified in M3/M4 | KIT_REVIEW #11 |
| Tuning source | ENEMY_DEFS in enemies.ts, behaviour numbers inline | **all in `src/data/tuning.ts`** (`T.enemies`, `T.behaviour`, `T.laser`, `T.caravan`) | T031 single source |
| Dart (T027) | 3-shot bursts / 1.6 s, 60 m/s, lead 0.8 | **4-shot bursts every 1.3 s, 50 m/s; burst lead brackets 0 -> 1.0 (where you are -> where you will be), fan 1.6 m; approach shots every 0.9 s, lead 0** | 350 bullets/run crossed mostly 8-15 m wide of the bot |
| Strider (T027) | 7 orbs / 1.7 s | **2 staggered rows of 7 (row gap 3.2 m) every 1.5 s**, orb damage 8; squad sweeps staggered 1.8 s per index | walls slipped by drifting vertically; 3 synced sweeps stacked 44 damage |
| Bullet damage / parry shield (T027) | 6 / +3 | **8 / +1** | combo + parry refill always restored 100 |
| Cloudgate finale (T027) | chains + darts to 164 | **+ walker at 145; rearguard strider trio 162-176; parting sniper crossfire 167** (few kills = no late refill) | A15: bot ends 62-78 shield over 10 seeds; live hostile 49 at t=150 (seed 1), window peak 53-60 |
| Violet Tide | - | **180 s, par 48000, railSeed 23**: dart squadrons crossing line-abreast (`strafe`: 26 m/s, a 2-shot pair every 0.75 s at lead 0.3 / 1.1), sniper crossfire pairs, horizontal sweeping sniper beams (+/-26 m over 1.3 s), strider pair at 86 s, last walker at 158 s | M3 |
| Wreckfield | - | **par 110000, railSeed 37**, BULWARK at 123 s, ends at the kill (~185-190 s); caltrop nets (`ring`: 10-14 drones on a 26 m circle closing to a point at u = 0, tracks the player until u = 70 m), double-weave chains | M3/M4 |
| BULWARK | 600/800/1000 | **2400 HP, phase 2 < 1800, phase 3 < 1000**; holds u 195 / y 34 (phase 3: 172 / 30); weak points 2 belly reactors + chin core (r 6 m) take **x5**; wingtrail ring deals 30 once per ring; P1 4 aimed beams 0.5 s apart (1.0 s telegraph, odd beams lead 0.5 s), recover 2.8 s; P2 2 beams + vent barrage 2x11 orbs every 4.2 s + 8-drone waves every 9 s; P3 beam wall (6 beams, 15 m gap, sweeps 26 m in 2.2 s, 1.2 s telegraph), recover 2.6 s, vents every 5.5 s, no drones | M4 |
| Boss escape | - | **rail end (250 s nominal) with BULWARK alive = results, cleared false (rank C)** | honest A10 |
| Caravan | 120 s, x1.4 | **Cloudgate waves (no prompts, no shield pickups) re-timed x1.4 into a 120 s loop (real time), parry gives no shield, par 60000** | A11 |

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
