# START HERE — CONTRAIL build kit (procedural, no keys, no logins)

This kit runs the GAME_FORGE process for a Rogue-Flight-style arcade rail shooter, fully procedural. Claude Code builds the rest.

## What you need
- Claude Code (signed in), Node 20+, git. Optional: ffmpeg (nicer timelapse), a real GPU (true fps).

## Run it locally (5 steps)
1. Make an empty folder and unzip this kit into it (you should see `GAME_FORGE.md`, `IDEA_CARD.md`, `Docs/`).
2. `git init` in that folder.
3. Start Claude Code in the folder.
4. Paste this message:

```
Read GAME_FORGE.md and IDEA_CARD.md and follow them end to end. MODE: procedural.
Do not ask me questions. A seed pack already exists in Docs/seed and Docs/refs:
follow GAME_FORGE section 4.6 (verify and extend, do not restart). Begin Phase 0.
```

5. Leave it running. Check in any time with: "Reply with: current milestone, last 3 DEVLOG entries, gate status, top 3 risks, next 3 TODOs, latest capture paths. Then keep working."

To end the run: ask for the wrap-up (GAME_FORGE section 10), then create `.claude/ALLOW_STOP`.

## Run it in the cloud instead
- Push the folder to a **private** GitHub repo (it contains copyrighted reference screenshots; never make it public), open claude.ai/code, pick the repo, and paste the same message.
- In the cloud environment settings use Custom network access with "include default list" and add `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`, plus this setup script:
  ```bash
  #!/bin/bash
  npx --yes playwright install --with-deps chromium || true
  ```
  (Hosts are from memory; if a download fails, the error names the blocked host.)
- In the cloud the agent must commit **and push** to the session branch often, because the VM is disposable. Tell it: "Push to the session branch after every commit." Consider 4-8 hour chunks; the state files let it resume.

## What is in the kit
| Path | What it is |
|---|---|
| `GAME_FORGE.md` | The protocol (procedural mode, agents, phases, gates, harness, reviewer) |
| `IDEA_CARD.md` | Pre-filled idea card for the game |
| `Docs/seed/CONCEPT_CARD.md` | Pre-written concept, scope, out-of-scope list, acceptance rows |
| `Docs/seed/DESIGN_SEED.md` | Mechanics/enemy/VFX numbers, each tagged observed / reported / assumption |
| `Docs/seed/STYLE_SEED.md` | Palette tokens, lighting, HUD rules, readability upgrades, lab boards to build |
| `Docs/refs/ANALYSIS.md` | Full research on the game plus clip-by-clip analysis |
| `Docs/refs/owner_refs.md` | Per-image notes (what to take, what not to copy) for 18 stills and 4 clips |
| `Docs/refs/owner/` | 18 stills extracted from your PDF |
| `Docs/refs/motion/` | Your 4 clips, contact sheets, and 92 frame images (~15 fps) |
| `Docs/refs/SOURCES.md` | Where each claim comes from |

## Decisions I made for you (change them in IDEA_CARD.md)
- **Original names.** "CONTRAIL", craft KESTREL, enemies WARDEN, boss BULWARK are placeholders. The game must not use the reference game's title, characters, portrait art, font, music or exact HUD glyphs, and nothing from `Docs/refs/` may ship (`npm run refcheck` enforces it).
- **Slice scope:** one polished stage first (Cloudgate), then two more stages, a boss and a 2-minute Caravan mode. Story paths, voice acting, 40 weapons and online features are out.
- **Readability is the differentiator:** reviewers criticised the original for enemies and lasers blending into backgrounds. The seed pack builds fixes into the design and measures them.
- **No anime faces:** procedural code does not sell them. Pilots are visored silhouettes.

## Honest limits
- Numbers tagged [A] in `DESIGN_SEED.md` are educated guesses; the clips are edited trailer excerpts and do not establish gameplay timing.
- Audio is verified numerically and by spectrogram only; you must listen.
- Headless fps is unreliable without a real GPU.
