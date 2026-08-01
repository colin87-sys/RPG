# REFERENCE TARGET — the look we are actually chasing

The user supplied five reference screenshots from the Final Fantasy Brave Exvius
line. This document is a forensic record of what is **visible in those frames**,
and it **overrides any conflicting instruction in ARCHITECTURE.md or
ART_BIBLE.md**. Where this file and another document disagree, this file wins.

Read this before writing a single line of visual code.

> Critical correction: earlier drafts of the art direction aimed at late-PS4
> stylised realism (FF7R / FF16). **That is the wrong target.** The reference is
> the chibi / super-deformed 3D JRPG look: toy-proportioned characters staged in
> a full 3D, painterly, heavily atmospheric environment. Everything below is
> derived from direct observation of the supplied frames.

---

## 1. Character proportions — the single biggest correction

The characters are **super-deformed (chibi)**, not realistic.

| property | value |
|---|---|
| total height | **3.0–3.5 heads tall** (not 7.5) |
| head | oversized, roughly **35–40% of total height**, near-spherical, slightly wider than tall |
| eyes | very large, high-contrast, occupying much of the face; simple bright iris + dark outline + a specular catch-light |
| nose / mouth | minimal or absent; the face reads on eyes and brows alone |
| torso | short and compact, roughly 1 head tall |
| limbs | short, tapered, **no visible elbow/knee articulation detail**; hands are mitten-like simple masses |
| feet | small, chunky, often boot-shaped wedges |
| hair | large, sculpted, **bold single-silhouette shapes** — not strands. Reads as carved volume with a glossy highlight band |

Characters must read as a clean, distinct **black silhouette at 80 px tall**,
because that is roughly how large they appear in the battle camera. Silhouette
distinctiveness between the six party members is a hard requirement, achieved
through hair shape, weapon shape, and cape/skirt outline — not through facial
detail, which is invisible at this size.

Shading on characters is **soft cel / toon-adjacent**, not full PBR: a broad
lit region, a soft terminator, a coloured shadow region, and — critically — a
**bright rim/back light** separating them from the background in every frame.
Materials are low-roughness-variation and mostly non-metallic; metal (armour,
blades) reads through a hard specular band rather than environment reflection.

---

## 2. Battle staging — fixed side-view

Every battle frame in the reference uses the same staging:

- **Camera**: fixed, wide (roughly 45–55° FOV), elevated ~10–18° looking slightly
  down, positioned to the side. Whole battlefield visible at once. Gentle idle
  drift only; no free orbit during command selection.
- **Party**: 4–5 characters on the **right**, arranged in a loose staggered
  diagonal (not a straight line) so all silhouettes stay readable.
- **Enemies**: on the **left**, generally larger than the party — bosses are
  dramatically larger, occupying 40–60% of frame height.
- Characters stand on visible ground with soft contact shadows.

## 3. Environments

Full 3D, painterly, and **deliberately muted so the characters pop**.

- Observed settings: a misty night battlefield with silhouetted trees; a green
  crystal ruin interior; a dusk pine forest; a bright desert with cacti; a lush
  sunlit glade.
- **Heavy atmospheric perspective is the signature.** Distant geometry washes
  toward the fog colour aggressively. Background elements are frequently near-
  silhouettes with very little internal detail.
- **Volumetric mist / god rays are present in nearly every frame**, pooling low
  to the ground and catching light.
- Depth of field is strong: the background is noticeably soft while characters
  stay crisp. This is a defining quality — a fully-sharp frame is wrong.
- Environment saturation sits **below** character and VFX saturation. The
  background is a stage, never competition.

## 4. Colour

Confirms and sharpens the existing Vesper palette:

- **Teal / cyan dominant** across mist, sky, UI and rim light.
- **Warm amber / gold** as the accent: torch light, sand, sunlit foliage, and
  UI selection highlights.
- **Magenta / violet** on enemies and dark magic.
- Magic VFX carry the only **fully saturated pure chroma** in frame.
- Night and dusk scenes crush toward deep blue-teal with the sky still holding
  visible cloud structure and colour — never flat black.

## 5. Visual effects

VFX are **bold, large, and unapologetic** — they dominate the frame when active.

- **Ribbon / swirl geometry** is the primary language: a green wind vortex spirals
  around the whole party; energy arcs sweep in wide curves.
- Layered **additive glow** with a bright, near-white core and saturated falloff.
- **Particle sprites**: gold stars, glass motes, embers, sparks — persistent
  ambient particles drift even outside of combat.
- Lightning renders as **branching high-contrast bolts** with a white core and a
  coloured outer glow, plus a screen-wide flash on impact.
- Status effects are shown as **floating world-space labels** (e.g. `STAGGERED`)
  in a coloured pill directly beneath the affected enemy.

## 6. UI — observed layout, to be matched closely

This is highly specific in the reference and should be reproduced in structure.

**Bottom bar — party status.** One block per party member, laid out horizontally:
- Character name in small clean caps.
- `HP` label with a numeric value, and a thin horizontal bar.
- `MP` label with a numeric value, and a thinner bar.
- Panel is a dark translucent slab with a subtle light top border.

**Right panel — ability list** (during command selection):
- Vertical list of rows, each with a small coloured element icon, ability name,
  and an `MP` / `AP` cost right-aligned.
- Selected row is highlighted with a **cyan/amber gradient bar** and brighter text.
- Some rows carry a small horizontal pip meter showing charge level.
- A **tooltip box** sits adjacent, describing the selected ability in one or two
  sentences of small body text — including conditional damage rules, e.g.
  *"Deal Wind magic damage to enemies. Damage increases by 50% if target is
  staggered."*

**Top — turn order timeline**: a row of small circular character portraits along
a gently curved band, showing upcoming turn sequence.

**Enemy HP**: floating bar above the enemy with its name and small element
affinity icons.

**Modal overlays**: a large centred title in wide-tracked white caps with a soft
outer glow (e.g. `SELECT RESONANCE`), a `Cancel` affordance beneath it, and a
radial/lattice node selector — a diamond arrangement of glowing cyan nodes
connected by thin lines, with named abilities labelled at the outer nodes.

**Corner affordances**: a `▶▶` fast-forward toggle and a `Hide Tips` button.

**Typography**: clean humanist sans, generous letter-spacing on titles, small
crisp body text with a subtle dark outline or drop shadow for legibility over
bright scenes. Never a browser default font.

## 7. World map

Shown as a **miniature diorama island**: high 3/4 aerial view, saturated and
bright, turquoise sea, layered cliffs and beaches, soft volumetric clouds, and a
small flying vessel crossing above it. Scale reads as a toy model, not a
continent. Much brighter and more saturated than the battle environments.

---

## 8. What this means for our implementation

Binding consequences:

1. `CharacterFactory` builds **chibi rigs at 3.0–3.5 heads**, not realistic
   humanoids. Bone names in the contract still apply; proportions change.
2. `LookdevScene`'s scale proxy must be a chibi proxy, not a 1.75 m capsule.
3. `BattleScene` uses the **fixed side-view stage** described above.
4. Character shading uses a **custom toon-ish material** with rim light, not
   stock `MeshStandardMaterial`. Environments may stay physically based.
5. Post-processing must lean **harder** on bloom, DOF and atmospheric fog than a
   realism target would — softness is correct here, not a defect.
6. The UI is a first-class deliverable and must match the observed structure.
7. Ambient drifting particles belong in essentially every scene.

## 9. Originality constraint

We are matching **art direction, rendering technique, staging and UI structure** —
a visual quality bar and a genre idiom. We are **not** copying Square Enix's
characters, names, story, logos or specific ability names. Rain, Lasswell, Fina
and Lid are their characters; ours are the six defined in `WORLD_BIBLE.md`.
Reproduce the craft, not the content.
