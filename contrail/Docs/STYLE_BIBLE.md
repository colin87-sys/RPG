# STYLE BIBLE — analogue-anime hard-surface (procedural)

**Authority:** `src/style/tokens.ts` holds every value; this bible explains them. Approved boards: `look/approved/` (index: `look/selection.json`). Where the seed text below disagrees, this table wins.

## Current values that supersede the seed text (see Docs/DECISIONS.md, Docs/REF_VERIFICATION.md)
| Rule | Seed | Current |
|---|---|---|
| HUD top band | ~6.5% | **8.5%** of frame height (bottom 9%) |
| HUD band backing | none | **gradient scrim** darker at the frame edge (C: 0.62 -> 0.40, +0.18 over bright sky); text outline x1.4 |
| HUD style | - | variant **C** (bold slanted original glyphs), labels SYS.STAT / TGT.DATA / ARMS / STREAK / HULL |
| Hostile bullet | >= 0.9% frame height | **core >= 1.8-2.0%**, yellow halo, opaque dark outline ring |
| Beam | white core + red halo | white core ~55-65% of width, warm edge line, strong red halo; telegraph line with dark outline |
| Shock ring | thin, 3% of radius | **3 separated R/G/B bands (~13% of radius)**, grows visibly |
| Violet Tide far fog | #C0567E | **#5C2A55** (dark sunset, median luminance < 6%) |
| Fog base height | -40 m | **-70 m** (below cloud-sea tops) |
| Hull mass | light steel | **near armourDark**, rim only on silhouette edges, ~256-300 small lights |
| Smoke | pale cream | pale on dark stages; **stage-adaptive darker (-25-30%) on Cloudgate** so it separates from clouds |
| Enemy look | - | variant **B** (seams + ink outline), dark bodies, thin warm rim, bright markers; BULWARK near-black with vent rows |
| Winners | - | hero B, enemies B, Cloudgate C, Violet C, Wreckfield C, structures B, HUD/screens C, post A, rings A, beams C, bullets B, smoke B, explosion A |

# STYLE SEED — analogue-anime hard-surface (procedural)

GAME_FORGE W2 promotes this to `Docs/STYLE_BIBLE.md` and `src/style/tokens.ts`. Keep every rule testable by looking at a capture. Owner references show the *relationships* below; do not reproduce their pixels, portrait, font or layouts.

## 1. Look keywords (the Reviewer grades against these)
1. Bright-to-dark drama: stages swing from near-white cloud to near-black debris; keep that range.
2. Readable spectacle: huge effects, but the craft, hostile fire, targets and pickups stay separable.
3. Thin-perimeter HUD, open centre.

## 2. Palette tokens (starting values; adjust in the lab, then freeze)
| Token | Hex | Use |
|---|---|---|
| sky.day | #098EC3 | Cloudgate sky base |
| cloud.cream | #E9ECD0 | cloud lit side |
| space.deep | #071C24 | Wreckfield background, HUD backing |
| armour.steel | #52687A | craft mid panels (lighter armour panels sit above this) |
| accent.orange | #E16C26 | craft inserts, exhaust, hostile warmth |
| burst.yellow | #F9EF00 | explosion core, beam core edge |
| hud.line | #2CA72F | HUD borders (measured from the stills) |
| hud.text | #75E845 | HUD text and active fills |
| shield.red | #ED2016 | shield bar, hostile threat halo |
| sunset.violet | derive: indigo #2A1F5A mid, magenta #B24A9C highlight | Violet Tide cloud layers (observed as layered indigo clouds, narrow orange horizon, bright sun) |
| sunset.horizon | derive: #FF8A2A band, sun core #FFF3C0 | Violet Tide |
Scene split: each scene 60% dominant field (sky/space), 30% secondary mass (clouds/structure/debris), 10% accents (effects, HUD, craft warmth). Shadows tint toward cool blue-violet, highlights toward warm cream.

## 3. Lighting
- One key-light direction per stage (Cloudgate: high-left sun; Violet Tide: low horizon sun, backlit craft; Wreckfield: rim-lit by a distant yellow planet).
- Rim light on the craft and enemies in every stage so silhouettes separate from cloud and debris.
- Fog: exponential height fog plus colour-shifted distance fade (cool haze in day, warm haze at sunset, near none in space).
- Bloom on effects only; UI is not bloomed.

## 4. Shape language
- Player craft: delta wing, swept trailing edges, wingtip fins/arcs, central fuselage, blue canopy glass, orange emissive inserts, thin panel seams (shader lines) and an original emblem on a black disc. Length ~12 m, wingspan ~9 m against a 1.8 m pilot figure in the lab scale line-up [A]. Silhouette test must read from the front and side.
- Enemies: stars (drones), wedges (fighters), tall bipeds (striders), broad winged capital (boss). Enemies are dark with warm rim and small emissive marker lights.
- Structures: large curved dark hull masses on one side of the corridor to frame the action (Cloudgate); floating wreck slabs and asteroids (Wreckfield).
- Colour never carries meaning alone: reticle = circle, target lock = square-corner brackets, hazards = striped, pickups = rotating gold/cyan diamonds.

## 5. Effects language
- Missile smoke: thick, pale, cream-white ribbons, persistent (>= 2 s, target 5 s), curved with camera motion.
- Explosion: white-yellow core, orange lobes, many small spherical blooms, sparks.
- Shock ring: thin ellipse with RGB-split (rainbow) edges, grows across 30-65% of the screen.
- Speed: radial streaks from the vanishing point, strongest at the edges.
- Beam: white core, wide red halo, telegraph line first.
- Post stack: RGB-split at the edges, scanlines, film grain, bloom, mild vignette. All budgeted; a "clean" toggle for the harness.

## 6. HUD rules (build it early; it appears in every lab board)
- Perimeter only: top band ~6.5% of frame height, bottom band ~9%, right-edge vertical ladder, bottom-right pilot frame. Centre and left/right mid-screen stay open.
- Top band, three angular segments: SCORE (left, corner label "STATS"), PROGRESS bar (centre), enemy info (right, corner label "TARGETS"). Bottom band, three angular cells: weapon (name, missile icon + count, SPECIAL chip READY/CHARGING), combo bar (centre), shield bar (right, red, numeric).
- Reticle: green circle with tick marks; lock brackets: red square corners; hazard state: top border turns yellow/black striped with a centred original warning line.
- Pilot frame: a visored-helmet silhouette generated in code (not a face), border turns red when danger is high.
- Font: an angular monospaced techno glyph set **drawn in code** (canvas/SVG paths). Do not copy or approximate the reference font.
- Everything from `tokens.ts`; no hard-coded colours.

## 7. Readability upgrades (our differentiator; reviewers criticised the original here)
1. Hostile projectile = white-hot core + yellow-orange halo + thin dark outline ring. Minimum size 0.9% of frame height at 60 m.
2. Lasers always start with a 0.7 s telegraph line; beams are never dark.
3. Player fire is a different colour family (cool cyan/white) and smaller, so it never hides hostile fire.
4. Enemy hit flash (2 frames white) plus a damage pop; larger enemies show a slim health sliver.
5. Background restraint: keep local background luminance low behind lasers; avoid hot-orange hostile fire on hot-orange backgrounds (Hot stage is P2).
6. Measured by `npm run readability` (object-ID mask contrast; see `CONCEPT_CARD.md` S6) and by the Reviewer.

## 8. Look-Dev Lab boards to build (variants A/B/C per subject, W3)
1. Hero craft: front, side, top, 3/4, close-up, black silhouette test, 1.8 m pilot scale figure.
2. Enemy line-up at relative scale beside the craft: caltrop drone, dart fighter, laser sniper, strider, boss.
3. Cloudgate vista at three cloud densities; Violet Tide vista with sun; Wreckfield vista.
4. HUD board: full frame with the perimeter HUD over Cloudgate, plus hazard state and danger-state portrait.
5. VFX strips: explosion (6 frames), shock ring (6 frames), missile smoke over time (5 frames), beam telegraph -> fire, muzzle/bullet readability at peak density.
6. Post-stack board: same frame with each post effect on/off.
Compare captures to `Docs/refs/owner/` *by relationship* (temperature range, layout, effect readability), and always compare A/B/C by paired comparison.

## 9. KEEP / UPGRADE / AVOID
KEEP: perimeter HUD with open centre; bright-to-dark stage contrast; persistent smoke ribbons; big boss silhouettes; RGB-split rings; warm hostile fire vs cool sky.
UPGRADE: projectile and laser readability; hit confirmation; upgrade signposting (show a "new upgrade" chip on the hangar and stage-start); roll as a resource, not a free spam.
AVOID: default grey materials; pure primaries; flat unlit shapes; anime faces; copying the reference's title, logo, characters, portrait, font, music or exact glyphs; dark-on-dark hostile fire.

## 10. REJECTED looks
- Photoreal PBR with no stylisation; low-contrast overcast sky; neon-only cyberpunk palette; full-screen fog that flattens depth; thick post effects that hide the craft.
