#!/bin/bash
# PreToolUse hook: in CLI mode, block Read on claude-brainrot images and force
# Claude to use show.sh instead. In Desktop mode, allow (Read is the right
# pattern there for inline rendering).

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

[ -z "$FILE_PATH" ] && exit 0
[[ "$FILE_PATH" != *"/.claude/skills/claude-brainrot/images/"* ]] && exit 0

# Detect mode
MODE="${CLAUDE_BRAINROT_MODE:-}"
if [ -z "$MODE" ]; then
  if [ -n "$TERM_PROGRAM" ]; then
    MODE="cli"
  else
    MODE="desktop"
  fi
fi

# Desktop mode: allow Read (it renders inline)
[ "$MODE" != "cli" ] && exit 0

# CLI mode: BLOCK and instruct
SKILL_DIR="$(dirname "$(dirname "$FILE_PATH")")"
SHOW_SCRIPT="$SKILL_DIR/scripts/show.sh"

cat >&2 <<EOF
🔴 BLOCKED — Read on claude-brainrot images is forbidden in CLI mode.

Read silently returns base64 image bytes; the USER SEES NOTHING. You must use the show.sh wrapper instead, which opens the image in Quick Look for ~3s and auto-closes:

    Bash $SHOW_SCRIPT "$FILE_PATH"

The PostToolUse hook will extract the image path from that bash command and fire the paired sound automatically. Retry your image emit using show.sh.
EOF

exit 2
