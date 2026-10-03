# IDEA CARD — CONTRAIL (working title)

MODE: procedural

One-liner: A stylish arcade rail shooter in an analogue-anime look: pilot a lone prototype fighter through cloud seas, sunsets and wreck fields, chaining lock-on missile barrages, drift-sweeps and parry-rolls into huge combos.

Feel / vibe: fast, spectacular, readable, bright-to-dark drama, 80s/90s analogue-video texture, thin perimeter HUD.

Reference games (mechanics/feel only): the arcade rail-shooter tradition (Star Fox, After Burner) and the recently released game "ROGUE FLIGHT" by Truant Pixel, studied through the supplied pack. Original title, names, art and story are required.

My notes / analysis reports: `Docs/refs/ANALYSIS.md`, `Docs/refs/owner_refs.md`, `Docs/refs/owner/` (18 stills), `Docs/refs/motion/` (4 clips + frame sequences), `Docs/refs/SOURCES.md`, and the seed docs in `Docs/seed/`.

Engine: web-threejs (Three.js + Vite + Playwright)

Run length: 24h (set 8h first if you want a first look sooner; the protocol resumes from the state files)

Budget: none. No paid services, no keys, no logins.

Must-have: perimeter HUD with open centre; lock-on missile barrage with persistent curved smoke; barrel-roll parry; drift; wingtrail shock ring; combo that refills shield; chromatic shock rings, radial speed streaks and analogue post stack; a bright cloud stage, a sunset stage and a dark debris stage; a big boss; readability better than the reference (see STYLE_SEED section 7).

Must-not-have: the reference game's title, logo, character names, story names, portrait art, font, music, exact HUD glyphs, or any file from `Docs/refs/` inside `src/`, `public/` or the build; anime faces; downloaded assets; external network requests in the shipped game.
