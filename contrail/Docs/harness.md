# Harness — CONTRAIL (GAME_FORGE W5 + Appendix C)

Node ES modules in `tools/`, driven by Playwright 1.56.1 (pinned; Chromium 141 pre-installed at `$PLAYWRIGHT_BROWSERS_PATH`, never run `playwright install`). No extra npm dependencies. All image work happens in Chromium (canvas); video uses Playwright's own ffmpeg.

## Common behaviour
- **Browser:** headless Chromium with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` (WebGL2 and float render targets through SwiftShader; no GPU). Viewport is exactly `w x h` at devicePixelRatio 1.
- **Server:** built-game checks use `vite preview` on **4173**, serving `dist/`. If `dist/` is missing the tool builds it (`--build` forces a rebuild) with `vite build` through the Vite API; `npm run build` is the typechecked build. If `src/main.ts` is missing, only the Lab page is built. `--dev` uses `vite` dev on **5209** instead (5210 is a spare; `--port n` overrides). If a server already listens on the port, it is reused only when it is this project's server. Otherwise the tool stops. Tools kill only the servers they started, by process-group PID. Logs go to `$TMPDIR/contrail-vite-*.log`.
- **Errors:** console errors, uncaught exceptions, failed requests (except `net::ERR_ABORTED`), HTTP >= 400 and `__game.errors()` are collected. Any of them fails capture, goldpath, perf, lab:capture and audiocheck.
- **Blank check:** captures are downscaled in-page. An image with luma std < 1 or <= 4 colours is flagged as blank and fails the run (`--allow-blank` to override).
- **Output line:** every tool ends with `PASS <tool>: ...` or `FAIL <tool>: ...`. Exit codes: 0 pass, 1 fail, 2 not available yet (readability API).
- **checks.json** (root) is updated through `tools/lib/checks.mjs`. It takes a lock, does a read-modify-write, then writes a temp file and renames it. It holds the Appendix C fields `utc`, `commit` (`git rev-parse --short HEAD`), `milestone` (`--milestone`, or `Docs/PLAN.md` "## Current"), `goldpath`, `perf`, `errors` (totals plus `by_tool`), `network`, `refcheck`, `audio` and `captures` (latest 100). It also holds `capture`, `readability` and `acceptance`. Each section carries its own `utc`, `passed` and `status`. Sections that have not run say `status: "not run"` with null values; nothing claims a pass it did not measure.

## Commands
| Command | What it does | Output |
|---|---|---|
| `npm run capture -- --cams hero,vista,combat,hud,title --seed 1 --t 12 [--stage cloudgate] [--w 1920 --h 1080] [--feature name] [--dev] [--clean] [--build]` | Per camera, on a fresh page: `/?det=1&seed&w&h&stage&mute=1[&clean=1]`, wait for `__game.ready`, then `start({stage})`, `setTime(t)`, `setCamera(cam)`, `step(2)`, then a page screenshot. The `title` camera skips `start` and `setTime`, because `setTime` would start a stage. | `Docs/captures/latest/<cam>.png`, `Docs/progress/<feature\|general>/<UTC>_<cam>.png`, `checks.capture` and `captures` |
| `npm run lab:capture -- --board hero --variants A,B,C [--dev] [--all] [--w --h --seed --timeout 120]` | `/lab/index.html?board&variant&w&h&seed`. Waits for `__labReady` and fails on `__labError`. Nothing is saved for a board that errors. | `look/candidates/<board>_<V>.png` and `.json` (`__labParams`) |
| `npm run contact -- <dir> [--out path] [--cols n] [--title text] [--width 1920]` | HTML grid of the images in `<dir>` (file:// URLs) with each filename and its real size, as a full-page screenshot. Missing images fail the run. | `<dir>/contact.png` |
| `npm run goldpath [-- --stage cloudgate --seed 1 --timeout 400 --require a,b\|none --log-every 5 --dev]` | Det mode: `setBot(true)`, `start({stage})`, then `step(60)` (one simulated second) until `results` (pass), or `gameover`, timeout, a title-stuck state or a stalled sim (fail). Never calls `setInvulnerable`. By default `counts()` must show `cannonFire, missileFire, enemyKilled:missile, parry, drift, wingtrail, shieldRefill`. Also requires `results.cleared === true` and zero page errors. | `Docs/progress/goldpath/<UTC>_{p25,p50,p75,results}.png`, `checks.goldpath` (`steps` every 5 s, `mechanics`, `missing_mechanics`, `counts`) |
| `npm run perf -- --scene cloudgate --t 150 --seconds 10 [--w 1920 --h 1080] [--no-bot]` | Det mode with the bot on: `setTime(t)`, 20 warm-up frames, then one `step(1)` per rAF for N seconds. Frame time is the interval between rAF callbacks. Reports the median and p99 ("1% low"), and samples `perf()` draw calls and triangles every frame. Exits 1 above 250 draw calls or 450k triangles. | `checks.perf` (`fps_median`, `fps_p1_low`, `frame_ms_*`, `draw_calls(_max)`, `triangles(_max)`, `method`) |
| `npm run netcheck [-- --build] [--play 10] [--boards all\|a,b]` | Serves `dist/` and loads `/`, `/?skip=1&bot=1&mute=1` (10 s of real time) and `/lab/index.html`. Records every request and websocket. External requests are recorded, then aborted. Fails on any host other than 127.0.0.1/localhost (`data:`/`blob:` are allowed). Also lists, for information only, the URL hosts written into the bundle text. | `checks.network` |
| `npm run refcheck [-- --build]` | Collects reference hashes from `tools/refs.manifest.json` plus every local `Docs/refs/**` file. Fails on any of these: a `dist/` file with a reference hash; an embedded `data:image` literal that decodes to a reference; a text excerpt of a local `.md` reference inside `dist/`; **any** image file in `dist/`; a reference file copied anywhere in the project outside `Docs/refs/` (`private/`, `node_modules/` and `dist*` are skipped). | `checks.refcheck` |
| `npm run audiocheck [-- --dev --timeout 300]` | `/lab/index.html?board=audio` → `window.__audioResults`. Thresholds: peak <= -1 dBFS; no clipping; \|DC\| < 0.01; SFX RMS -30..-10 dBFS; music RMS -24..-12 dBFS; loop seam ok. The music RMS range applies only to intensity-0.6 items when intensities are named (`x0.6`, `@0.6`, `intensity=0.6`, or an `intensity` field). | `Docs/captures/audio/<name>.png`, `checks.audio` (`status: pending owner review`) |
| `npm run readability -- --t 150 --stage cloudgate [--cam play] [--selftest]` | S6 readability (method below). Exits 2 if `__game.readabilityMasks` is missing. `--selftest` checks CIEDE2000 against 11 Sharma (2005) reference pairs and runs a synthetic mask. | `Docs/captures/readability/<UTC>_*.png` (overlay: green >= 25, red < 25), `checks.readability` |
| `npm run timelapse [-- --dir Docs/progress --out Docs/timelapse.webm --fps 4 --match hero]` | Takes the `<UTC>_*.png` files in name order and draws each onto a 1280x720 captioned JPEG in Chromium. The JPEGs are piped to `ffmpeg -f image2pipe -framerate 4 -c:v mjpeg -i pipe:0 -c:v libvpx -b:v 2M -r 4 -pix_fmt yuv420p`. | `Docs/timelapse.webm`, plus `Docs/timelapse.html` (always written; slideshow with relative paths) |
| `npm run acceptance [-- --skip a,b --only a,b]` | Runs build (tsc + vite), netcheck, refcheck, goldpath, perf, audiocheck and readability against one shared preview, then prints a table. Readability is P1 (exit 2 → n/a); every other step is P0. | `checks.acceptance`; exits 1 if any P0 step fails |

## Debug API the harness uses (`src/debug/api.ts`, exposed with `?det=1` / `?debug=1` / dev)
`ready`, `start({stage})`, `setTime(t)`, `step(n)`, `setCamera(name)` / `cameras()`, `state()` (state, progress, score, shield, kills, results.cleared, ...), `setBot(on)`, `counts()`, `errors()`, `perf()` (drawCalls, triangles, softwareGL). The harness never calls `setInvulnerable`. Note that `setTime()` itself uses the bot and invulnerability while it fast-forwards; goldpath never calls `setTime`.
**Proposed addition:** `readabilityMasks(): Promise<{frame: string, mask: string}>`. Both are PNG data URLs of the same camera and size. The mask draws hostile projectiles pure white on black and everything else black.

## S6 readability method
For each connected component (8-connected, mask > 127, at least 4 px), the tool compares two colours:
- **projectile colour:** the mean CIELAB (D65) of the frame pixels under the component;
- **local background:** the mean CIELAB of a ring around it. The ring is the chessboard dilation by 1 + r px minus the dilation by 1 px, where r = clamp(round(0.75 · r_eq), 3, 12). All mask pixels are removed from the ring, so neighbouring projectiles do not count as background.

The difference is ΔE = **CIEDE2000** between the two means. The report gives the median and the 10th percentile. Pass: median ΔE00 >= 25. The maths lives in `tools/lib/readability-math.mjs` and runs in the page on canvas ImageData.

## Known limits
- **fps is software-GL relative.** SwiftShader runs on the CPU (4 shared vCPUs), so the numbers are only good for before/after comparisons on the same machine. They are labelled `software-GL relative (SwiftShader, no GPU)`. Real-GPU fps is `pending owner review`. Budgets (draw calls, triangles) are exact.
- **Video:** Playwright's ffmpeg only has `pipe`/`file` protocols, MJPEG decode and VP8 WebM, so the tools cannot decode MP4 (reference clips) or make GIF/MP4. Use `Docs/refs/motion/frames/`.
- **Audio** is judged by numbers and spectrograms only: `pending owner review`.
- **Goldpath** uses a deterministic bot and seed. Passing proves the loop works and that each mechanic can fire; it says nothing about difficulty.

## Troubleshooting
- `port 4173 is busy with a server that is not this project's ...`: another process holds the port. Stop it, or pass `--port`.
- `window.__game is not exposed`: the page was loaded without `det=1`/`debug=1`, or `src/main.ts` failed to boot. The error lists `window.__errors`.
- `unknown board` in a built run: the board was added after the last build. Pass `--build` or `--dev`.
- A board takes longer than the wait: the first dev-server load compiles deps (the audio board once took over 120 s cold, 23 s warm). Raise `--timeout`.
- Stale `checks.json` lock: `$TMPDIR/contrail-checks.json.lock` is cleared automatically after 30 s.
- Set `HARNESS_DEBUG=1` for stack traces and ffmpeg logs.
