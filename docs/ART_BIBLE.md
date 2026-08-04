# AETHERWIND SAGA — Art Bible

This document is binding on every module that puts a pixel on screen. Where
ARCHITECTURE.md says "cool shadows, warm key", this file says exactly how cool
and exactly how warm. If a value here conflicts with your instinct, ship the
value here. If a value here produces something ugly in your scene, report it —
do not silently drift.

Numbers are authoritative. Hex values are sRGB. Intensities assume
`renderer.toneMapping = ACESFilmicToneMapping` and physically-correct lights.

---

## 1. The visual premise

Erevane is a civilisation living inside the light of its own dead god. The moon
shattered eight centuries ago; its shards hang in a glowing ring across the sky,
and everything below is lit twice — once by a warm, ordinary sun, and once by
the cold teal ember-light of the ring. Magic is burned memory, and spent spells
fall back to earth as drifts of tiny glass petals. So the world is beautiful
the way autumn is beautiful: every gorgeous thing in frame is evidence of
something ending. The art direction's job is to make the player feel that
without a single line of dialogue — warmth in the key light, grief in the
shadows, and one saturated jewel-tone of magic burning in every frame like the
last coal in a hearth.

**The single image the whole game is chasing:** dusk on the Glasspetal Fields.
A lone figure walks away from camera through waist-high grass toward a horizon
where the shattered moon-ring rises, huge and teal, out of amber haze. The
grass is backlit rim-gold; the shadows pool blue-green; glass petals drift
through a shaft of light like snow that catches fire; the figure's cloak drags
a slow second of motion behind every step. Melancholy, grandeur, borrowed time.
Every scene, menu, and battle camera is graded toward this frame.

---

## 2. The Vesper Palette — named colour system

The base of every frame is **teal-and-amber**. Saturated pure chroma is
reserved for magic; nothing else in the frame is allowed to compete with it.

### 2.1 Light and atmosphere

| name | hex | use |
|---|---|---|
| `KEY_SUN` | `#FFD9A3` | directional key light at noon. Warmer variants per time-of-day below. |
| `BOUNCE_GROUND` | `#D9A06B` | hemisphere ground colour / fill bounce. Always warmer and darker than key. |
| `SHADOW_TINT` | `#2E4A5F` | the colour shadows lerp toward. Deep desaturated teal, never grey. |
| `RING_GLOW` | `#5FB8B0` | ambient contribution of the moon-ring; secondary rim light at night/dusk. |
| `FOG_NEAR` | `#6E93A6` | fog colour sampled at ground level / short distances. Cool teal. |
| `FOG_FAR` | `#C4B49A` | fog colour at horizon distance. Warm parchment — the far haze is always warmer than the near fog so depth reads as cool→warm. |

**The shadow rule (mandatory, no exceptions):** shadows are never neutral.
Every ambient/fill term is tinted so that a white surface in full shadow
renders within ±8° hue of `SHADOW_TINT #2E4A5F` (hue ≈ 206°) at that
time-of-day's ambient level. Practically: hemisphere light sky colour =
`mix(skyZenith, SHADOW_TINT, 0.5)`; never use `0x808080`, `0x404040`, or any
zero-saturation colour for ambient, hemisphere, or fill lights. Minimum
saturation of any shadow-region colour: **0.15**. If you can eyedrop a grey
out of a shadow, it is a bug.

### 2.2 Elemental accents

These are the ONLY colours in the game allowed to reach full chroma and to
exceed 1.0 in emissive HDR (drive bloom). Everything else stays inside the
teal-amber envelope. Emissive intensity for spell cores: 2.5–6.0 (HDR, pre-
tonemap); ambient magic props (crystals, runes): 1.2–1.8.

| element | name | hex | secondary/core hex |
|---|---|---|---|
| fire | `EMBER` | `#FF6B2B` | core `#FFD08A` |
| ice | `RIME` | `#7DE3FF` | core `#EAFBFF` |
| lightning | `FULMEN` | `#FFE95C` | core `#FFFFFF`, fringe `#B98CFF` |
| water | `TIDE` | `#3FA9F5` | core `#A8E4FF` |
| earth | `LOAM` | `#C98F3F` | core `#F2D9A6` |
| wind | `ZEPHYR` | `#8FE6A0` | core `#E6FFEE` |
| light | `HALLOW` | `#FFF0B8` | core `#FFFFFF`, gold fringe `#FFC24D` |
| dark | `UMBRAL` | `#8C4DD9` | core `#2B1245`, fringe `#D94D8C` |

Rule of one jewel: a composed frame contains **at most one** dominant elemental
accent at a time. Two elements may coexist only during clash moments
(fire vs ice) and for ≤ 1.5 s.

### 2.3 Value structure

- Crush blacks: the grade maps input 0.0 → output ~0.02, and floor lift is
  tinted `#0A1218` (teal-black), never `#000000` across large areas.
- Let highlights clip through bloom: sun disc, spell cores and specular pings
  are allowed ≥ 1.0 pre-tonemap. Everything else must land 0.05–0.85.
- Target frame histogram: ~15% of pixels below 0.08 (foreground framing),
  ~10% above 0.75 (sky, rims, magic). If the histogram is a hump in the
  middle, the shot is flat — re-light it.

---

## 3. Time-of-day keys

`Sky.setTimeOfDay(t)` interpolates between these four keys (t = 0.0 night,
0.25 dawn, 0.5 noon, 0.75 dusk, wrapping). Interpolate in linear space.
Fog density is for `THREE.FogExp2`. Exposure is `renderer.toneMappingExposure`.
Ambient intensity is the summed hemisphere+probe contribution relative to a
key light of intensity 3.0 (noon, physically-correct mode).

| key | sun colour | sun intensity | sky zenith | sky horizon | fog colour | fog density | exposure | ambient |
|---|---|---|---|---|---|---|---|---|
| **dawn** (t=0.25) | `#FF9E5E` | 2.2 | `#2A3E66` | `#FFB37E` | `#C58A6B` | 0.0045 | 1.05 | 0.35 |
| **noon** (t=0.50) | `#FFEAD0` | 3.0 | `#33628F` | `#BFD9E2` | `#A8C4CC` | 0.0018 | 1.00 | 0.55 |
| **dusk** (t=0.75) | `#FF6B3D` | 2.4 | `#35275E` | `#FF9E6B` | `#8A5E7A` | 0.0055 | 1.15 | 0.30 |
| **night** (t=0.0) | `#A8C8E8` (moon-ring) | 0.9 | `#0B1226` | `#1E3050` | `#16283C` | 0.0035 | 1.25 | 0.18 |

Additional per-key notes:

- **Dawn**: sun elevation 8°. Long shadows are the feature — shadow length
  ≥ 4× object height. Ring barely visible, alpha 0.15.
- **Noon**: the *least* dramatic key on purpose; it exists so dusk feels
  earned. Sun elevation 62°, never 90° (top-down light kills silhouettes).
- **Dusk**: the hero key — the game's default field time is t = 0.72.
  Ring alpha 0.6, `RING_GLOW` rim light intensity 0.8 from the ring's
  sky direction (opposite the sun azimuth).
- **Night**: key light is the ring, not a white moon — tint `#A8C8E8`,
  and warm practicals (`#FFB36B`, intensity 1.5, distance-attenuated) carry
  all warmth in frame. Stars fade in above horizon +15°, ring alpha 1.0.

---

## 4. Material philosophy

Nothing flat. Every material carries (a) roughness variation ≥ ±0.08 across
its surface via procedural map, (b) normal detail, and (c) either a fresnel
rim or baked micro-occlusion in its cavity map. "Albedo value" is the linear
luminance range the base map must stay inside — real-world-plausible albedo
keeps GI and exposure sane.

| surface | roughness | metalness | albedo value (linear) | required detail |
|---|---|---|---|---|
| stone | 0.72–0.92 | 0.0 | 0.18–0.42 | cavity AO in mortar lines; moss tint `#5E7A4A` in up-facing crevices |
| marble | 0.25–0.45 | 0.0 | 0.55–0.80 | subsurface approximation: fresnel-boosted `#EAE2D4` rim; veining contrast ≤ 0.15 |
| wood | 0.55–0.75 | 0.0 | 0.22–0.45 | ring-grain normal; roughness follows grain (aniso-ish streaking) |
| bark | 0.80–0.95 | 0.0 | 0.10–0.25 | deep normal furrows, AO ≥ 0.4 in cracks |
| foliage | 0.45–0.65 | 0.0 | 0.12–0.30 | two-tone: lit face `#6B8F4A`, underside `#3D5C33`; translucency term 0.35 backlit |
| cloth | 0.75–0.95 | 0.0 | 0.20–0.55 | weave normal ≥ 2px repeat; sheen colour = albedo lightened 20% |
| silk | 0.30–0.50 | 0.0 | 0.30–0.65 | anisotropic sheen along warp; specular tint toward `#FFE9D0` |
| leather | 0.50–0.70 | 0.0 | 0.10–0.30 | pore normal + worn-edge roughness drop to 0.35 on seams |
| steel | 0.30–0.55 | 1.0 | 0.50–0.60 (F0 via metalness) | anisotropy 0.6 along blade axis; grind-line normal; edge wear lightening |
| gold | 0.20–0.40 | 1.0 | tint `#FFC24D`→`#D9964A` | never clean: AO grime `#4A3418` in recesses |
| crystal | 0.05–0.15 | 0.0 | transmission look: opacity 0.55–0.75 | emissive interior 1.2–1.8 in elemental accent; fresnel rim mandatory |
| water | 0.02–0.10 | 0.0 | absorption tint `#0E3A42` | dual scrolling normal (0.7 & 1.3 scale, 12° divergent); fresnel reflectance floor 0.02 |
| skin | 0.38–0.55 | 0.0 | 0.35–0.55 (tone-dependent) | fresnel rim `#FF9E7A` at 0.25 strength fakes SSS; roughness drops to 0.30 on nose/lips |

Global material rules:

- Metal is `metalness: 1.0` or `0.0` — never fractional except on ≤ 2px
  transition borders in a map.
- Every hero material gets an env-map contribution from `art.environment()`;
  envMapIntensity 0.6 default, 1.0 for metal/crystal, 0.25 for cloth.
- Emissive on non-magic surfaces is forbidden. Warm windows at night use
  actual small `PointLight`s or emissive planes tinted `#FFB36B` ≤ 1.5 — that
  is a "practical", the one exception.

---

## 5. Composition — binding rules for every camera pose

A camera pose is a *composition*, not a coordinate. Each of the named poses
(`hero-closeup`, `battle-command`, `wide`, `esper`) and every cutscene shot
must satisfy:

1. **Three depth layers.** Foreground (0.5–4 m): an occluder — foliage, an
   arch, a shoulder — occupying 8–20% of frame area, exposed ≥ 1.5 stops
   under the subject, allowed to blur (DOF near). Midground: the subject,
   full value range. Background: haze-lifted, contrast compressed ≥ 40% by
   fog. If your shot has no foreground occluder, move the camera until it
   does — this is the single cheapest depth win we have.
2. **Thirds.** Subject centre-of-mass on a rule-of-thirds intersection.
   Horizon on the lower or upper third line, never centred. Dead-centre
   framing is reserved for the antagonist and esper reveals only (symmetry
   as menace).
3. **Lens discipline.** Closeups 35 mm-equiv (FOV ≈ 34°), battle/command
   45 mm (FOV ≈ 28° portrait feel) to 24 mm (FOV ≈ 55°) for wides, esper
   shots 18–21 mm low-angle. Never above FOV 60° — wide-angle stretch reads
   as "tech demo".
4. **Camera height.** Field default: 1.35 m (chest height), pitched −6°.
   Hero shots slightly low (1.1 m, pitch +4°) so characters read heroic.
   Top-down angles are forbidden outside the map screen.
5. **Atmospheric depth cue.** Fog must be visibly separating layers by 40 m
   at noon density and 25 m at dusk. If the background reads at full
   contrast, raise density locally rather than shipping a flat shot.
6. **Silhouette check.** Flatten the frame to black shapes: the subject must
   be identifiable. If a character's silhouette merges with the background
   value, add a rim light (`RING_GLOW` at 0.8, or key-coloured at 1.2) —
   rims are earned by silhouette failure, not sprinkled by default.

---

## 6. Post-processing intent

Chain order is fixed by ARCHITECTURE.md. Each stage exists for one reason;
strengths below are the `high` quality targets (scale down, never up).

| stage | purpose | target |
|---|---|---|
| SSAO | contact grounding, not global darkening | radius 0.35 m, intensity 0.55, tinted toward `SHADOW_TINT` not black |
| bloom | HDR overspill from magic/sun/speculars ONLY | threshold 1.0, strength 0.35, radius 0.6. If base-albedo surfaces bloom, threshold is wrong. |
| DOF | eye direction in dialogue/closeups | dialogue: focus at subject, bokeh scale 2.5; field/battle: OFF except esper cams (focus ∞, near blur only) |
| motion blur | weight for fast camera moves | shutter 0.5, camera-only; per-object blur off (cost) |
| radial blur | limit-break adrenaline | 0.0 at rest; spikes to 0.35 for ≤ 0.4 s on `limit-release` |
| chromatic aberration | lens realism at frame edge; impact punch | steady-state 0.0012 (edge-weighted, zero in centre 40%); impact spike 0.004 decaying over 0.25 s |
| grade + tonemap | the teal-amber contract | ACES; split-tone: shadows → `#2E4A5F` @ 0.6, highlights → `#FFD9A3` @ 0.45; saturation 1.05; contrast 1.06 |
| grain | dither banding, filmic texture | luminance-weighted 0.035, animated per-frame via blue-noise, coarser (0.05) in `sorrow` grade |
| vignette | eye containment | darkness 0.28, offset 1.1, tinted `#0A1218` |
| FXAA | edge cleanup | always on |

Named grades for `setGrade`: `default` (values above), `sorrow` (desat to
0.85, shadows deeper `#22384A`, grain 0.05), `ember` (highlights `#FFB36B`,
vignette 0.34 — burning zones), `void` (shadows `#2B1245`, aberration 0.002 —
dark-aligned scenes), `verdant` (green-shifted bounce `#7A9E6B` — deepwood).

**What over-processing looks like — calibrate against this:** if bloom halos
sit on unlit stone, if the vignette is visible as a border rather than felt,
if aberration fringes text or the frame centre, if grain crawls on faces in
dialogue, if DOF blurs anything the player is trying to walk toward, or if
the grade makes skin tones go grey-green — pull the offending stage back 50%.
The post stack should be invisible until a screenshot with it disabled looks
suddenly dead.

---

## 7. Never ship

Any of these in a build is a failed review:

1. Default grey `MeshStandardMaterial`, or any material with uniform
   roughness and no maps.
2. Neutral-grey or black ambient/shadow terms (see §2.1 shadow rule).
3. A flat single-colour clear background, or a sky with no gradient.
4. Two saturated elemental accents idling in one frame.
5. `AmbientLight` doing more than 20% of scene illumination (kills form).
6. Shadowless point lights on hero subjects; shadow maps under 1024px on
   the key light.
7. A camera pose with no foreground occluder and no atmospheric layering.
8. Snapping: any visible state change (light, camera, UI, pose) without
   easing ≥ 150 ms.
9. Cloth, hair, or capes that stop moving when the character does.
10. UI in a browser default font, pure-white `#FFFFFF` UI panels, or
    text without at least 4.5:1 contrast on its backing.
11. Bloom threshold below 0.9, vignette darkness above 0.4, grain above
    0.06 — the "more juice" failure.
12. FOV > 60°, top-down cameras, or a horizon across frame centre.
13. Water without fresnel, metal without anisotropic streaking, crystal
    without interior glow.
14. `Math.random()` anywhere a screenshot can see.
