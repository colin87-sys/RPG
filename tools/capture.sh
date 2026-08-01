#!/usr/bin/env bash
# Build, serve, and capture a scenario in one shot.
#
#   tools/capture.sh field shots/field
#
# Serialised by an flock so concurrent callers queue instead of fighting over
# dist/ and the preview port.
set -euo pipefail

SCENARIO="${1:-field}"
OUT="${2:-shots/$SCENARIO}"
PORT="${AW_PORT:-4173}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec 9>"/tmp/aw-capture.lock"
flock 9

npm run build >/dev/null 2>&1 || { echo "BUILD FAILED"; npm run build 2>&1 | tail -30; exit 1; }

# Reuse a live preview server if one is already up, otherwise start one.
if ! curl -sf -o /dev/null "http://localhost:$PORT/"; then
  npx vite preview --port "$PORT" --strictPort >/tmp/aw-preview.log 2>&1 &
  PREVIEW_PID=$!
  trap 'kill $PREVIEW_PID 2>/dev/null || true' EXIT
  for _ in $(seq 1 40); do
    curl -sf -o /dev/null "http://localhost:$PORT/" && break
    sleep 0.5
  done
fi

# The scenario name rides on the URL because screenshot.mjs is frozen and its
# scenarios open the lookdev stage through an argument-less `gotoLookdev` hook.
# Without this tag both the `lookdev` and `cast` sheets would shoot the stage's
# single default composition and ship the same frame under two names; main.js
# maps the tag to an entry pose. Anything that ignores the tag still gets the
# battle frame, which is the composition the reference specifies.
node tools/screenshot.mjs \
  --scenario "$SCENARIO" \
  --out "$OUT" \
  --url "http://localhost:$PORT/?scenario=$SCENARIO"
