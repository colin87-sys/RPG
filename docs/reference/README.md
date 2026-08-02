# Reference plates

The client's actual reference screenshots. **Every agent doing visual work must
open these before writing code, and open them again to check its output.**

Where a written document and these images disagree, **the images win.** The
prose specs in `docs/BRAVELY_REFERENCE.md`, `docs/ANIME_PIPELINE.md` and
`docs/REFERENCE_TARGET.md` were transcribed by eye from these plates before the
plates themselves were available, and at least eight numbers in them turned out
to be wrong. Trust what you can see.

## Bravely Default II — the primary target

These define character construction, proportions, costume detail, shading and
environment quality.

| file | what it shows |
|---|---|
| `bravely01.jpg` | **The hero plate.** 1920×1080. Four-character party in a sunlit flower meadow — lavender, tulips, cherry blossom, boulders. Best available evidence for proportions, costume layering, material response and environment density. Also shows the right-hand HP/MP/BP UI stack. |
| `bravely02.jpg` | 1280×720. Same party in winter outfits on a reflective purple ice plane with teal aurora. Stylised set-piece arena lighting; shields and staves. |
| `bravely03.jpg` | Dialogue staging — over-the-shoulder from behind the party, cream speech bubble, `L Auto-Advance / R Skip`. |
| `bravely04.jpg` | Spell-cast close-up. Cyan energy swirl, floating petals, `Eternal Inferno` ability banner, battle-speed control. |
| `bravely05.jpg` | Single-character close-up of the ninja. **The best plate for costume detail** — layered straps, fur collar, mask, belts, gloves. |

## Final Fantasy Brave Exvius — the earlier reference

Supplied first. Useful mainly for battle UI structure and VFX scale; the
Bravely plates supersede these for character construction.

| file | what it shows |
|---|---|
| `ffbe01.jpg` | `SELECT RESONANCE` radial node selector, turn-order band, party HP/MP bar, `STAGGERED` enemy pills. |
| `ffbe02.jpg` | Green crystal ruin, boss encounter, heavy ribbon VFX. |
| `ffbe03.jpg` | Forest dusk boss, right-hand ability list with MP costs and a tooltip describing conditional damage. |
| `ffbe04.jpg` | World map diorama island plus a desert battle. |
| `ffbe05.jpg` | Bright forest glade, ability list with AP costs, `Hide Tips`. |

## How to use these

1. **Open the plate before you write code.** Find *your* element in it — if you
   are building hair, look at the hair; if you are building the UI, zoom into
   the right-hand stack.
2. **Open it again with your own capture** and compare region by region. State
   which is better and why.
3. Measure rather than estimate. Proportions, colours and layout can all be read
   directly off `bravely01.jpg`.

## Provenance and scope

These are copyrighted screenshots from published Square Enix titles, kept in the
repository solely as internal art direction reference. We reproduce technique,
staging and interface *structure*. We do not copy their characters, names,
story, logos or ability names — ours are defined in `docs/WORLD_BIBLE.md`.
