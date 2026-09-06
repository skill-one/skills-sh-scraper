#!/bin/bash
# Archive an email by moving it to the Archive mailbox
# Usage: ./archive-email.sh <message_id> [account] [mailbox] [archive_mailbox]
# Output: Success or error message

MESSAGE_ID="${1:-}"
ACCOUNT="${2:-}"
MAILBOX="${3:-INBOX}"
ARCHIVE_MAILBOX="${4:-}"

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

# Build archive logic based on whether custom archive mailbox is specified
if [ -n "$ARCHIVE_MAILBOX" ]; then
    ARCHIVE_LOGIC="
        set archiveMailbox to missing value
        repeat with mb in mailboxes of theAccount
            if name of mb is \"$ARCHIVE_MAILBOX\" then
                set archiveMailbox to mb
                exit repeat
            end if
        end repeat

        if archiveMailbox is missing value then
            return \"ERROR:Archive mailbox '$ARCHIVE_MAILBOX' not found for this account\"
        end if"
else
    ARCHIVE_LOGIC='
        -- Find the Archive mailbox for this account (try common names)
        set archiveMailbox to missing value
        repeat with mb in mailboxes of theAccount
            if name of mb is "Archive" or name of mb is "Archives" or name of mb is "All Mail" then
                set archiveMailbox to mb
                exit repeat
            end if
        end repeat

        if archiveMailbox is missing value then
            return "ERROR:No Archive mailbox found for this account. Try specifying archive_mailbox parameter with the exact folder name."
        end if'
fi

osascript <<EOF
tell application "Mail"
    try
        set theMailbox to $ACCOUNT_PART
        set theMessage to (first message of theMailbox whose id is $MESSAGE_ID)
        set theAccount to account of theMailbox
        $ARCHIVE_LOGIC

        move theMessage to archiveMailbox
        return "Message archived successfully"
    on error errMsg
        return "ERROR:" & errMsg
    end try
end tell
EOF
