# PIPELINE_LESSONS — short rules (problem / cause / fix)

## Playwright / Chromium
- **Browser mismatch** — a caret `playwright` range pulls a version whose Chromium is not installed. Fix: pin `playwright` exactly to the version matching `/opt/pw-browsers` (1.56.1 -> chromium-1194).
- **Headless WebGL** — works with `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`; fps is meaningless there, draw calls/triangles are exact.
- **Blank screenshots** — enable `preserveDrawingBuffer` in capture mode and screenshot after a render + RAF.
- **HMR kills captures** — other lanes editing files triggers Vite reloads mid-capture; retry, or capture against `vite preview` of a build.
- **Canvas taint** — `file://` images taint canvases; pass images as data URLs read in Node.
- **MP4 refs** — Playwright Chromium cannot decode H.264; use pre-extracted frames.
- **ffmpeg** — Playwright's ffmpeg only takes `image2pipe` MJPEG in and VP8 WebM out.

## Shell / process
- **`pkill -f "vite --port"` (and `pgrep -f` in a loop) killed the calling shell** (the pattern matches its own command line; exit 144). Fix: bracket the first letter, e.g. `pgrep -f "[v]ite --port 5199"`.
- **API session limits stop background agents** mid-task. Fix: commit partial lane work immediately; resume agents with SendMessage (they keep their transcript).

## Shaders / three.js
- **`#include` inside a one-line shader string fails** — preprocessor directives need their own line (`\n#include <colorspace_fragment>\n`).
- **Instance IDs passed as varyings must be rounded** — interpolation gives 1.9999 and picks the wrong atlas cell (stripes).
- **Uniform name clashes with the shared rig** (`uRimStrength`) — prefix lane uniforms.
- **TypeScript `as const` tuning tables** make literal types; annotate locals `: number` when reassigning.
- **Additive rim light** turns edge-on dark surfaces grey (T022).

## Design
- **Seed camera 9 m behind** made the 9 m craft fill 75% of the frame; refs imply ~20 m (DECISIONS).
- **Smoke emitted per time (30/s) at 110 m/s leaves gaps**; emit per distance (every ~0.6 m).

## Things that cost hours
- (append here)
