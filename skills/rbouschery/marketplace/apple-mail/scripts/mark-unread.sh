#!/bin/bash
# Mark an email as unread
# Usage: ./mark-unread.sh <message_id> [account] [mailbox]
# Output: Success or error message

MESSAGE_ID="${1:-}"
ACCOUNT="${2:-}"
MAILBOX="${3:-INBOX}"

if [ -z "$MESSAGE_ID" ]; then
    echo "ERROR:Message ID is required"
    exit 1
fi

# Build the account/mailbox part
if [ -n "$ACCOUNT" ]; then
    ACCOUNT_PART="mailbox \"$MAILBOX\" of account \"$ACCOUNT\""
else
    ACCOUNT_PART="mailbox \"$MAILBOX\""
fi

osascript <<EOF
tell application "Mail"
    try
        set theMailbox to $ACCOUNT_PART
        set theMessage to (first message of theMailbox whose id is $MESSAGE_ID)
        set read status of theMessage to false
        return "Message marked as unread"
    on error errMsg
        return "ERROR:" & errMsg
    end try
end tell
EOF
