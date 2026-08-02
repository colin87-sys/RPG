# BRAVELY DEFAULT II — the reference, corrected

**This document is the highest authority on character and environment art in
this repository.** It supersedes `REFERENCE_TARGET.md` and `ANIME_PIPELINE.md`
wherever they disagree. Read it before writing any visual code.

> **Why it exists:** the client supplied five Bravely Default II screenshots
> after reviewing our cast and saying "our characters look nothing like them."
> They were right. Several specs in the earlier documents were **wrong**, not
> merely incomplete, and had been driving the cast away from the target for
> multiple rounds. The corrections are in §1.

> **On the images themselves:** the screenshots live in the operator's
> conversation, not on disk. They cannot be exported into this repo or into a
> subagent's context — there is no file to store. This document is the
> substitute, written from direct observation. Treat every number in it as
> measured from the reference, not invented.

---

## 1. CORRECTIONS to the earlier specs — read these first

| spec | what earlier docs said | what the reference ACTUALLY shows |
|---|---|---|
| **Height** | 3.0–3.5 heads | **4.0–4.5 heads.** Noticeably taller and more substantial. Adults (Elvis) read near 4.5; younger characters near 4.0. |
| **Head size** | ~38% of height | **~22–25% of height.** Still large, nowhere near the earlier figure. |
| **Eyes** | enormous, ~30% of face width each, dominating | **Moderate.** Detailed and expressive, with visible upper and lower lids, defined lashes and a proper iris — but they occupy maybe a third of what the earlier spec demanded. These are *refined anime faces*, not super-deformed baby faces. |
| **Nose / mouth** | omit the nose entirely | **Both present.** A small but real nose with a defined bridge, and a proper mouth. Cheekbones and jawline read. Elvis has a full beard and moustache. |
| **Outlines** | heavy ink line, 1.5–2.5 px | **Subtle to absent.** There is no visible ink outline in any reference frame. Separation comes from lighting and colour, not from a drawn line. Our heavy outline push was wrong. |
| **Shading** | hard 2-band cel, narrow terminator | **Soft, stylised-PBR.** Smooth gradients, real specular on metal, soft fabric falloff. There is no hard banded terminator anywhere. Closer to what we had *before* the cel rewrite. |
| **Environments** | muted, misty, heavy atmospheric perspective, strong DOF | **Bright, sharp, saturated and highly detailed.** A sunlit meadow with individually modelled flowers. Background is crisp, not washed out. Mist and heavy DOF are wrong for the field. |
| **Body form** | short tapered limbs, no articulation, mitten hands | **Real anatomy.** Elbows, knees, defined shoulders, individual fingers on gloved hands, proper footwear. |

**The single biggest gap is costume detail.** See §3. Our characters are flat
colour blocks; the reference has richly constructed garments.

---

## 2. Proportions and the face

- **Total height:** 4.0–4.5 heads. Torso ~1.3 heads, legs ~1.8 heads.
- **Head:** large relative to a realistic figure but clearly a stylised adult
  head, not a sphere. It has a tapering jaw, a chin, and a cranium that is
  wider at the top than the bottom.
- **Eyes:** almond-to-rounded, with a distinct dark upper lash line (thinner
  than the earlier spec's "thick bar"), a visible lower lid, a detailed iris
  with a limbal ring and a highlight. Adult characters have narrower, sharper
  eyes; younger ones rounder.
- **Brows** sit close above the eye and are shaped, not a blunt stroke.
- **Nose:** small, with a visible bridge and tip. **Do not omit it.**
- **Mouth:** small, properly shaped, capable of expression.
- **Hair:** layered and structured, with distinct locks and strands catching a
  soft highlight — spiky fringes, ponytails, topknots, sculpted waves. It is
  *not* one flat carved volume, and *not* a noisy texture. Think stacked,
  overlapping tapered locks.

## 3. Costume — the defining feature

This is where the reference is dramatically ahead of our work, and where most
remaining effort should go. Observed in the frames:

- **Layered plate armour**: separate pauldrons, chest plate, faulds, vambraces,
  each an individual piece with its own edge and its own specular response, worn
  over a tabard and mail.
- **Long coats** with embroidered patterning running down the front panels
  (rose motifs in deep red), structured lapels, and turned cuffs.
- **Patterned fabric**: one dress carries a full multicoloured print — orange,
  blue, violet — not a flat colour. Another uses an iridescent green-gold weave
  under a black fishnet overlay.
- **Trim everywhere**: white collars, ribbons, buckles, straps, belts with
  visible hardware, laced boots, fur and feather collars, veils and netting.
- **Silhouette accessories**: a tall soft chef's hat with a red pompom, a small
  black hat with veil, hoods, capes, scarves.

**Rule:** every character needs at least **six distinguishable garment
elements** (e.g. coat + collar + belt + gloves + boots + accessory), each with
its own colour and material, layered so the silhouette has internal structure.
A single-colour mass with one belt is the current failure mode.

## 4. Materials and shading

- Soft, smooth diffuse falloff. **No hard terminator.**
- **Metal is genuinely metallic**: armour shows real environment reflection and
  a bright specular, with darker recesses between plates.
- Fabric is matte with soft shading and visible weave or print where the design
  calls for it.
- Fur and feather trim reads as broken, soft-edged silhouette.
- A subtle rim/back light separates characters from the background, but it does
  not clip to white and it is not a substitute for an outline.

## 5. Environments

- **Bright and sharp.** A sunlit meadow: individually modelled lavender spikes,
  red and white tulips, a pink cherry blossom in bloom, layered grey boulders,
  crisp green grass with visible blade detail.
- Saturated natural colour — greens, purples, pinks — under clear daylight.
- Background stays **in focus**. Depth of field is minimal in field battles.
- Dramatic set-piece arenas are the exception and go stylised: a mirror-like
  purple ice plane reflecting the party, teal aurora flame along the horizon,
  a deep starfield sky. High contrast and saturated, but still sharp.

## 6. UI — observed layout

**Right-hand party stack**, one row per character, vertically arranged:
- Character name in a serif-ish face, right-aligned.
- `HP` label + numeric value, then a thin bar.
- `MP` label + numeric value, then a thinner bar.
- A **gold ornate diamond** to the right showing the character's **BP** count.
- Values are large and legible; the whole stack is unboxed, sitting directly
  over the scene with a soft drop shadow for contrast.

**Ability banner**: when an ability fires, its name appears in a dark
horizontal bar across the lower-centre of frame (e.g. `Eternal Inferno`).

**Battle speed control**: top-left or bottom-left, showing `− +  Battle Speed`
with a `▶▶` fast-forward affordance.

**Dialogue**: a cream rounded-rectangle speech bubble with a tail, black serif
text, floating in world space near the speaker. Top-right shows
`L Auto-Advance   R Skip`.

**Camera in dialogue**: over-the-shoulder from behind the party, characters
seen from the back at three-quarter, speaker facing them.

## 7. Battle staging

- Party of four, standing in a **loose line across the middle of frame**,
  full-body, side-on to slightly three-quarter, at mid distance.
- Characters occupy roughly the middle third of frame height.
- Ground is visible beneath them with soft contact shadows.
- Camera is near eye level with a slight downward tilt — much flatter than the
  elevated angle the earlier spec called for.

## 8. What to change in our build, in priority order

1. **Rebuild proportions** to 4.0–4.5 heads with real elbows, knees and hands.
2. **Rebuild the face**: smaller refined eyes, add a nose, add a proper mouth,
   give the head a jaw and chin instead of a sphere.
3. **Build costume layering** — six-plus garment elements per character with
   distinct materials, plus pattern support for printed fabric.
4. **Remove the heavy ink outline**; keep at most a very subtle edge.
5. **Soften the cel terminator back toward smooth stylised-PBR.**
6. **Brighten and sharpen the field environment**; drop the heavy mist and DOF,
   and build real flower, grass, rock and blossom-tree geometry.
7. **Build the UI** to the layout in §6.

## 9. Originality

We match art direction, construction technique, staging and UI *structure*.
We do not copy Square Enix's characters, names, story or logos. Seth, Gloria,
Elvis and Adelle are theirs; ours are the six in `WORLD_BIBLE.md`.
