# ANIME CHARACTER PIPELINE — how the cast is actually built

> **⚠ PARTIALLY SUPERSEDED by `docs/BRAVELY_REFERENCE.md`. Read that first.**
> Bravely Default II reference frames showed several specs below are wrong:
> proportions are 4.0–4.5 heads (not 3.0–3.5), eyes are moderate and refined
> (not enormous), the nose and mouth are present (not omitted), outlines are
> subtle to absent (not a heavy ink line), and shading is soft stylised-PBR
> (not a hard two-band terminator).
> What remains correct here: **the face is a painted texture on a 3D head**,
> and **no procedural noise touches a character surface**.

This document supersedes any character-rendering guidance elsewhere in the repo.
It exists because the first attempt failed in a specific, diagnosable way, and
the failure was architectural rather than a matter of tuning.

## Settled: characters are 3D, not sprites

Confirmed with the client. Characters are **real 3D geometry** — skinned meshes
on skeletons, procedurally animated, lit by the scene, casting and receiving
shadows, and viewable from any angle so summon and limit-break cameras can move
around them.

The **face is 2D art on a 3D head**, which is not a contradiction and is exactly
how every 3D anime game does it. Do not read "painted face texture" as licence
to build billboard sprites.

## Why the first attempt failed

The cast was built as **modelled geometry lit by a physically-based-ish shader
with procedural noise textures on every surface**. That produces generic
stylised low-poly. It cannot produce anime, no matter how it is tuned.

Anime 3D — FFBE, Genshin Impact, Guilty Gear Xrd, Blue Protocol, every one —
works on four principles our pipeline violated:

| principle | what we did | what is required |
|---|---|---|
| The face is a **painted texture** on a simple head mesh | tried to model/shade facial features into geometry | draw eyes, brows and mouth into a texture; UV it onto the face |
| Shading is **cel**: flat bands, hard terminator | smooth PBR-ish falloff | 2 bands, sharp-ish step, coloured shadow |
| Albedo is **flat and saturated**, colour-blocked | fBm noise smeared over hair and cloth | zero noise on characters; clean flat regions |
| **Inverted-hull outlines** give the ink read | no outlines, or too subtle to see | dark outline, constant screen-space weight |

**Rule: no procedural noise texture ever touches a character surface.** Noise
belongs on terrain, rock, bark and cloth *props*. On a character it reads as
dirt. Characters are flat colour plus a painted face plus a highlight band.

---

## 1. The face texture

The single highest-value asset in the game. Draw it with the 2D canvas API into
a 512×512 (or 1024) texture, then UV-map the front of the head sphere to it.

### Layout, in fractions of the face texture

Origin top-left. The face occupies the central region; the head mesh's UV front
maps to it.

| feature | position | size |
|---|---|---|
| eye centres | y ≈ 0.56 of head height; x ≈ 0.30 and 0.70 | each eye ≈ 0.26 wide, ≈ 0.30 tall |
| gap between eyes | ≈ one eye width | — |
| brows | ≈ 0.13 above eye top | ≈ 0.9 × eye width, thick short stroke |
| mouth | y ≈ 0.80, centred | tiny, ≈ 0.08 wide |
| nose | omit, or a single 2 px dot at y ≈ 0.72 | — |

### The eye, drawn back to front

This ordering matters; each layer sits on the one before.

1. **Sclera** — rounded shape, near-white with a faint cool tint at the top
   (`#F4F7FA` → `#E4EAF2` vertical gradient). Slightly wider than tall, with the
   outer corner lower than the inner corner.
2. **Iris** — a large circle filling ~85% of the eye height, so it reads as a
   big eye. Vertical gradient: darker at the top (shadowed by the lash), most
   saturated in the middle, lighter at the bottom. Use the character's eye
   colour from `roster.js`.
3. **Iris ring** — a darker rim (~12% of the iris radius) around the outer edge.
   This one detail does most of the work in making an eye read as anime.
4. **Pupil** — a dark ellipse, ~35% of iris width, centred, taller than wide.
5. **Upper lash line** — a **thick dark bar** across the top of the eye, roughly
   18–22% of eye height, extending slightly past the outer corner and tapering.
   This is the heaviest black in the whole face and defines the eye's shape.
   Near-black, tinted toward the hair colour rather than pure `#000`.
6. **Lower lid** — a much thinner, softer line, often only along the outer half.
7. **Highlights** — a large white circle in the upper-*outer* quadrant of the
   iris (radius ≈ 22% of iris) and a smaller one in the lower-inner quadrant.
   Both fully opaque white. Without these the eye reads dead.

### Brows
Short, thick, slightly curved strokes in the hair colour darkened ~25%. Angle
carries personality: down-inner = determined, up-inner = gentle, flat = cool.

### Mouth
A single small curve. Closed neutral is a short shallow arc. Nothing more —
a detailed mouth breaks the style instantly.

### Skin
Flat. `#F7DCC4` warm pale as a base; the cel shadow band is a **warm rose-tan**
(`#E0A98F`), never grey and never a darkened copy of the base.

---

## 2. Cel shading

- **Two bands.** `smoothstep(t - w, t + w, N·L)` with the threshold `t ≈ 0.5` and
  a narrow width `w ≈ 0.03–0.06`. Wide soft ramps read as PBR, not anime.
- **Shadow colour is a hue shift, not a multiply.** Shift toward the scene's
  shadow tint and *increase* saturation slightly as value drops. A darkened copy
  of albedo is the single most common way cel shading looks cheap.
- **A third rim band** is allowed on the lit side for hair and metal only.
- **Specular is a hard-edged shape**, not a soft lobe: threshold the Blinn-Phong
  term to produce a crisp highlight blob.
- **Faces get flatter lighting than bodies.** Anime faces deliberately resist
  shadowing so they stay readable — clamp the face's shadow term to a minimum of
  ~0.75 so a nose or fringe never carves the face into darkness.

## 3. Hair

- Built from **chunky geometric shells / clumps**, not strands and not a
  noise-textured dome. Each clump is a broad tapered form with a clear point.
- **Flat base colour.** One value. No fBm, no mottling, no per-pixel variation.
- **One anisotropic highlight band** running across the crown, perpendicular to
  the strand direction — a bright, slightly desaturated band with hard-ish edges.
- Silhouette does all the work: spikes, sweeps, twin-tails, a long fringe.

## 4. Outlines

- Inverted-hull: duplicate the mesh, flip winding to `THREE.BackSide`, push
  vertices along their normals in **view space** scaled by distance so line
  weight stays constant on screen (~1.5–2.5 px at 1080p).
- Outline colour is **not black** — use a heavily darkened, saturated version of
  the underlying albedo, so hair gets a dark-warm line and cloth a dark-cool one.
- Skip outlines on the eyes; the painted lash line already provides that weight.

## 5. Costume colour blocking

Each character must read as **three or four flat colour zones**, assigned per
vertex or by UV region — not by texture noise:

- a dominant garment colour (the character's identity colour, saturated),
- a secondary/trim colour (complementary or much lighter),
- a metal/leather accent (small area, higher value),
- skin.

At battle-camera distance a viewer should identify each character by colour
alone. Currently all six read as the same dark navy mass, which is a total
failure of this rule.

## 6. What "anime" means in one line

Flat saturated colour, a hard shadow terminator, an ink outline, and a painted
face with enormous glossy eyes. If a frame has smooth gradients, muddy desaturated
colour, no outline and no eyes, it is not anime — regardless of the proportions.
