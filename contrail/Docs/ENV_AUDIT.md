# ENV_AUDIT — CONTRAIL (GAME_FORGE 4.3)

Audited 2026-09-30T04:47Z in the Claude Code cloud container (Linux 6.18, 4 vCPU, 15 GiB RAM, no swap).

| Item | Result | Fallback / note |
|---|---|---|
| Node / npm | v22.22.2 / 10.9.7 | meets Node 20+ |
| git | 2.43.0; remote `origin` = github.com/colin87-sys/RPG (public) | refs pack kept out of git (see DECISIONS) |
| `npm install` (network) | works (registry.npmjs.org via the container proxy) | — |
| Playwright + Chromium | Chromium 141.0.7390.37 pre-installed at `/opt/pw-browsers/chromium-1194`; matches Playwright **1.56.1** (pinned) | `npx playwright install chromium` not needed here; on a local machine it installs the matching build |
| Headless WebGL | **WebGL2 works** with default flags and with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`. Renderer: `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))`. MAX_TEXTURE_SIZE 8192, `EXT_color_buffer_float` available (HDR render targets OK) | harness launches with the swiftshader flag set for stability |
| OfflineAudioContext | works in headless Chromium (48 kHz stereo render verified) | audiocheck renders in-page |
| Real GPU | **none** (no `nvidia-smi`, SwiftShader only) | fps reported as software-GL relative frame time, labelled; real-GPU fps `pending owner review` |
| ffmpeg | no system ffmpeg; Playwright's `ffmpeg-linux` (n7.0.1) supports `image2pipe` + MJPEG decode + VP8/WebM encode | timelapse = JPEG frames piped to VP8 WebM; HTML slideshow as a second fallback |
| Python | 3.11, no PIL | not needed: all image work is done in Chromium (canvas) |
| MP4 decoding | not attempted (Playwright Chromium lacks H.264) | use pre-extracted frames in `Docs/refs/motion/frames/` |
| Disk | ~30 GB free | — |

Conclusions: every harness command in GAME_FORGE Appendix C is feasible. The only gap is true fps, which is measured and labelled as relative.
