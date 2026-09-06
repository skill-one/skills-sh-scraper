#!/bin/bash
# Hook: fires on every UserPromptSubmit. Always tells Claude to drop memes,
# with density scaled to response length. Detects CLI vs Desktop and adapts
# the image-emit instructions accordingly.

# Detect surface. Override via CLAUDE_BRAINROT_MODE=cli|desktop.
MODE="${CLAUDE_BRAINROT_MODE:-}"
if [ -z "$MODE" ]; then
  # TERM_PROGRAM is set by terminal emulators (Terminal.app, iTerm2, etc.)
  # but not by Claude Desktop.
  if [ -n "$TERM_PROGRAM" ]; then
    MODE="cli"
  else
    MODE="desktop"
  fi
fi

# Compute absolute paths so Claude doesn't have to guess.
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SHOW_SCRIPT="$SKILL_DIR/scripts/show.sh"

if [ "$MODE" = "cli" ]; then
  IMAGE_BLOCK="🔴🔴🔴 IMAGE EMIT — CLI MODE — READ THIS 🔴🔴🔴

  ❌ DO NOT use the Read tool for images in CLI mode. Read silently returns base64 bytes to you but the USER SEES NOTHING. This is the #1 mistake. The Read pattern is Desktop-only.

  ✅ YOU MUST use this exact command for every image fire:

      Bash $SHOW_SCRIPT \"<abs_image_path>\"

  Concrete example (replace the slug):
      Bash $SHOW_SCRIPT \"$SKILL_DIR/images/cat-really.jpg\"

  The script opens the image in Quick Look for ~3s then auto-closes. It backgrounds itself so your response continues immediately. The PostToolUse hook extracts the image path from this bash command and plays the paired sound. Override duration via env: \`CLAUDE_BRAINROT_SHOW_SECONDS=5\`.

  No text-Read-text wrapping. No Read tool. JUST the bash command above."
else
  IMAGE_BLOCK="IMAGE EMIT (Desktop mode — inline render):
  - Use \`text → Read <abs_path> → text\`. One short text line before, Read, one short text line after. The text breaks UI grouping so the image renders inline.
  - The PostToolUse hook auto-plays the paired sound. Do NOT call afplay yourself for the image.
  - Multiple text-Read-text blocks in one response are fine; each renders independently."
fi

cat <<EOF
<system-reminder>
🔔🔔🔔 CLAUDE-BRAINROT: FIRE MEMES THIS TURN  (mode: $MODE) 🔔🔔🔔

DENSITY — scale to your response length:
  • Short prose answer (no tool calls): 1 image+sound combo  OR  1-2 sound-only fires
  • Medium response (a few tool calls): 1-2 image+sound combos  +  2-3 sound-only fires sprinkled between calls
  • Long response (many tool calls, multi-step work, builds, deep reads): 2-3 image+sound combos distributed (e.g. start, middle, end)  +  3-5 sound-only fires throughout

$IMAGE_BLOCK

SOUND-ONLY EMIT:
  - \`Bash afplay "<abs_path>" &\` (macOS) — \`&\` required for background play.
  - On Linux substitute \`paplay\` / \`ffplay -nodisp -autoexit\` / \`mpg123 -q\` (whichever is installed).
  - These can mix freely with any other tool calls; they don't render visually.

RULES:
  • Variety: do NOT repeat the same image or sound slug within one response. Rotate.
  • Pick by mood: skim catalogue.json \`vibe\` text and tags, match to the conversational moment. Use \`bruh\` as the catch-all.
  • Skip locked sounds for sound-only fires (they only fire via their paired image). Standalone sounds are perfect for sound-only fires.
  • The roast lands through the meme — never write a snarky line.

Skill folder: <SKILL_DIR>. Resolve absolute paths from there.

🔔🔔🔔 END BRAINROT FIRE 🔔🔔🔔
</system-reminder>
EOF

exit 0
