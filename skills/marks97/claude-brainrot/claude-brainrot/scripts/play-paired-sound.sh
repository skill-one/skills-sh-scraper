#!/bin/bash
# Hook: fired after Claude opens a meme image (via Read in Desktop, or Bash
# open/xdg-open/start in CLI). Picks a sound and plays it.
# Selection priority:
#   1. silent: true            -> exit, no sound
#   2. lock_sound: "<slug>"    -> always play that
#   3. preferred_sounds: [...] -> 80% pick from these, 20% tag overlap
#   4. tag overlap (excluding locked + standalone sounds)
# Cooldown is Claude's responsibility (tracked in conversation context).

INPUT=$(cat)

# Try Read tool input first
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# If no file_path, this might be a Bash call — extract the image path from the command
if [ -z "$FILE_PATH" ]; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
  FILE_PATH=$(echo "$COMMAND" | grep -oE '[^ "'"'"']*\.claude/skills/claude-brainrot/images/[^ "'"'"']+' | head -1)
fi

[ -z "$FILE_PATH" ] && exit 0
[[ "$FILE_PATH" != *"/.claude/skills/claude-brainrot/images/"* ]] && exit 0

SKILL_DIR="$(dirname "$(dirname "$FILE_PATH")")"
CATALOGUE="$SKILL_DIR/catalogue.json"
[ ! -f "$CATALOGUE" ] && exit 0

BASENAME=$(basename "$FILE_PATH")
IMAGE_SLUG="${BASENAME%.*}"

# 1. Silent → bail
SILENT=$(jq -r --arg s "$IMAGE_SLUG" '.images[] | select(.slug==$s) | .silent // false' "$CATALOGUE")
[ "$SILENT" = "true" ] && exit 0

# 2. Locked sound → use it
LOCK_SOUND=$(jq -r --arg s "$IMAGE_SLUG" '.images[] | select(.slug==$s) | .lock_sound // empty' "$CATALOGUE")

if [ -n "$LOCK_SOUND" ]; then
  SOUND_SLUG="$LOCK_SOUND"
else
  # 3. Preferred sounds → 80% pick from there
  PREFERRED=$(jq -r --arg s "$IMAGE_SLUG" '.images[] | select(.slug==$s) | (.preferred_sounds // []) | .[]' "$CATALOGUE")
  ROLL=$((RANDOM % 100))

  if [ -n "$PREFERRED" ] && [ "$ROLL" -lt 80 ]; then
    SOUND_SLUG=$(echo "$PREFERRED" | awk 'BEGIN{srand()} {a[NR]=$0} END{if(NR>0) print a[int(rand()*NR)+1]}')
  else
    # 4. Tag overlap (exclude locked + standalone)
    IMAGE_TAGS_JSON=$(jq -c --arg s "$IMAGE_SLUG" '.images[] | select(.slug==$s) | .tags' "$CATALOGUE")
    [ -z "$IMAGE_TAGS_JSON" ] && exit 0

    CANDIDATES=$(jq -r --argjson it "$IMAGE_TAGS_JSON" '
      .sounds
      | map(select((.locked // false) | not))
      | map(select((.standalone // false) | not))
      | map(select(.tags | any(. as $t | $it | index($t))))
      | .[].slug
    ' "$CATALOGUE")

    [ -z "$CANDIDATES" ] && exit 0
    SOUND_SLUG=$(echo "$CANDIDATES" | awk 'BEGIN{srand()} {a[NR]=$0} END{if(NR>0) print a[int(rand()*NR)+1]}')
  fi
fi

[ -z "$SOUND_SLUG" ] && exit 0

SOUND_REL=$(jq -r --arg s "$SOUND_SLUG" '.sounds[] | select(.slug==$s) | .path' "$CATALOGUE")
[ -z "$SOUND_REL" ] && exit 0

SOUND_PATH="$SKILL_DIR/$SOUND_REL"
[ ! -f "$SOUND_PATH" ] && exit 0

# Cross-platform sound playback. Tries players in order; first one wins.
play_sound() {
  local f="$1"
  if command -v afplay >/dev/null 2>&1; then
    afplay "$f"
  elif command -v paplay >/dev/null 2>&1; then
    paplay "$f"
  elif command -v ffplay >/dev/null 2>&1; then
    ffplay -nodisp -autoexit -loglevel quiet "$f"
  elif command -v mpg123 >/dev/null 2>&1; then
    mpg123 -q "$f"
  elif command -v mplayer >/dev/null 2>&1; then
    mplayer -really-quiet "$f"
  elif command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -c "Add-Type -AssemblyName presentationCore; \$p=New-Object system.windows.media.mediaplayer; \$p.open('$f'); \$p.Play(); Start-Sleep -Seconds 30" >/dev/null 2>&1
  fi
}

( play_sound "$SOUND_PATH" >/dev/null 2>&1 & )

exit 0
