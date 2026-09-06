#!/bin/bash
# Show a meme image briefly (3s) then auto-close. CLI-only — for Claude Code
# CLI mode where there's no inline render. Backgrounds the show so Claude's
# Bash call returns immediately (sound hook can fire concurrently).
#
# Usage: show.sh <abs_path_to_image>

IMG="$1"
[ -z "$IMG" ] && exit 0
[ ! -f "$IMG" ] && exit 0

DURATION="${CLAUDE_BRAINROT_SHOW_SECONDS:-3}"

(
  if command -v qlmanage >/dev/null 2>&1; then
    # macOS Quick Look — single transient window, killable
    qlmanage -p "$IMG" >/dev/null 2>&1 &
    PID=$!
    sleep "$DURATION"
    kill "$PID" 2>/dev/null
  elif command -v feh >/dev/null 2>&1; then
    # Linux — feh is a lightweight viewer that respects --geometry, kill on timer
    feh --auto-zoom --geometry 600x600 "$IMG" >/dev/null 2>&1 &
    PID=$!
    sleep "$DURATION"
    kill "$PID" 2>/dev/null
  elif command -v xdg-open >/dev/null 2>&1; then
    # Linux fallback — no clean way to auto-close, just open
    xdg-open "$IMG" >/dev/null 2>&1 &
  elif command -v start >/dev/null 2>&1; then
    # Windows / WSL — open via default handler, no auto-close
    start "" "$IMG"
  fi
) >/dev/null 2>&1 &

exit 0
