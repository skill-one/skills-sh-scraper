#!/bin/bash
# List mailboxes/folders for a specific account or all accounts
# Usage: ./list-mailboxes.sh [account]
# Output: account:mailbox1, mailbox2|||account2:mailbox1, mailbox2|||...

ACCOUNT="${1:-}"

if [ -n "$ACCOUNT" ]; then
    osascript <<EOF
tell application "Mail"
    set results to {}
    try
        set acc to account "$ACCOUNT"
        set mailboxList to {}
        repeat with mb in mailboxes of acc
            set end of mailboxList to name of mb
        end repeat
        return mailboxList
    on error
        return {}
    end try
end tell
EOF
else
    osascript <<'EOF'
tell application "Mail"
    set results to ""
    repeat with acc in accounts
        set accName to name of acc
        set mailboxList to {}
        repeat with mb in mailboxes of acc
            set end of mailboxList to name of mb
        end repeat
        set results to results & accName & ":" & (mailboxList as string) & "|||"
    end repeat
    return results
end tell
EOF
fi
