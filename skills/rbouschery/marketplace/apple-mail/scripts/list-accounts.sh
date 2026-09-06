#!/bin/bash
# List all email accounts configured in Apple Mail
# Usage: ./list-accounts.sh
# Output: Comma-separated list of account names

osascript <<'EOF'
tell application "Mail"
    set accountList to {}
    repeat with acc in accounts
        set end of accountList to name of acc
    end repeat
    return accountList
end tell
EOF
