#!/bin/bash
# Get unread email count
# Usage: ./get-unread-count.sh [account] [mailbox]
# Output: Number of unread emails

ACCOUNT="${1:-}"
MAILBOX="${2:-}"

if [ -n "$ACCOUNT" ] && [ -n "$MAILBOX" ]; then
    osascript <<EOF
tell application "Mail"
    return unread count of mailbox "$MAILBOX" of account "$ACCOUNT"
end tell
EOF
elif [ -n "$ACCOUNT" ]; then
    osascript <<EOF
tell application "Mail"
    set total to 0
    repeat with mb in mailboxes of account "$ACCOUNT"
        set total to total + (unread count of mb)
    end repeat
    return total
end tell
EOF
elif [ -n "$MAILBOX" ]; then
    osascript <<EOF
tell application "Mail"
    set total to 0
    repeat with acc in accounts
        try
            set total to total + (unread count of mailbox "$MAILBOX" of acc)
        end try
    end repeat
    return total
end tell
EOF
else
    osascript <<'EOF'
tell application "Mail"
    set total to 0
    repeat with acc in accounts
        repeat with mb in mailboxes of acc
            set total to total + (unread count of mb)
        end repeat
    end repeat
    return total
end tell
EOF
fi
