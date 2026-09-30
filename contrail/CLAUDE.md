# CLAUDE.md — CONTRAIL
You are building CONTRAIL, an original procedural arcade rail shooter (Three.js + Vite + TS). Full task: `Docs/TASK.md`. These rules outrank later inference.
Mode: **procedural** — no keys, no logins, no external assets, zero external requests in the shipped game.

## 1. Read order (after every start, restart or compaction)
1. `CLAUDE.md` 2. `Docs/PLAN.md` (incl. gate status), `Docs/TODO.md`, `Docs/TASK.md` sections 4 and 6 3. last three entries of `Docs/DEVLOG.md` and `Docs/DECISIONS.md`, `Docs/STATS.json`
4. Before visual work: `Docs/STYLE_BIBLE.md`, `src/style/tokens.ts`, `look/approved/*` (and `Docs/refs/owner/` if present — private, local only)
5. Run `date -u`. **Every timestamp you write comes from `date -u`, never estimated.**

## 2. Autonomy
Never ask the owner; decide, log to `Docs/DECISIONS.md` (UTC, options, reason), continue. Never end the run on your own: when TODO is empty run `npm run acceptance` and queue fixes. Retry tool failures twice, then switch route and log. Stuck > 45 min: write what was tried, take the fallback or cut, move on. Max 3 attempts per module per stage.

## 3. Records and cadence
DEVLOG at every milestone, recovered failure, and at least hourly. STATS.json hourly. Progress captures after every significant visual change (`npm run capture -- --feature <name>`). **Commit every 30-60 min and push to the session branch after every commit** (cloud VM is disposable).

## 4. Orchestration
Director/Integrator owns `src/main.ts`, `src/core/*`, `src/game/*`, `src/debug/*`, build config, `package.json`, git. Lanes own `src/gen/<lane>/`, their lab boards, manifests; they append to `Docs/INTEGRATION_QUEUE.md`. Shared rules for lanes: `Docs/LANE_BRIEF.md`. Every agent returns files, evidence paths, open issues; no evidence = not finished.

## 5. Always playable
`npm run goldpath` passes at every commit from M1 on. A change that breaks it and is not fixed in 20 min is reverted and re-queued.

## 6. Procedural discipline
Colours only from `src/style/tokens.ts` (helpers in `src/style/color.ts`). Seeded `Rng` only, never `Math.random()`. Custom materials use `src/gen/common/lighting.ts` (one key, one rim, one fog). Board before build (`src/lab/boards/`). Budgets in `Docs/TASK.md` section 7.

## 7. Verification
Open every image before describing it. A fresh Reviewer agent judges captures (GAME_FORGE section 12, paired comparison). You cannot hear: audio is numeric + spectrogram only, always `pending owner review`. Status words: implemented / agent-verified / pending owner review.

## 8. Web / Three.js practice
Headless Chromium uses SwiftShader (no GPU): fps is relative only; draw calls/triangles are exact. Debug API `window.__game` (`src/debug/api.ts`) with `?det=1&seed=&cam=&t=`. Instancing and pooling; no per-frame allocation in hot loops. Sim is rail-space and deterministic (`src/game/`), view maps it to three.js (`src/game/view.ts`).

## 9. Boundaries
Work only inside `contrail/`. **Never commit `Docs/refs/`** (private third-party references; the host repo is public) or any image that embeds reference pixels (use `private/`). Network only for `npm install`. Pushes only to the session branch. Never force-push or rewrite history.

The harness, hooks and goldpath driver change only between milestones, with a commit.
