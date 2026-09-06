#!/bin/bash
# Get specific email(s) by ID
# Usage: ./get-email-by-id.sh <id> [account] [mailbox] [include_content]
# For multiple IDs, pass comma-separated: ./get-email-by-id.sh "123,456,789"
# Output: id<<>>subject<<>>sender<<>>to<<>>cc<<>>bcc<<>>dateSent<<>>isRead<<>>content|||...

IDS="${1:-}"
ACCOUNT="${2:-}"
MAILBOX="${3:-INBOX}"
INCLUDE_CONTENT="${4:-true}"

if [ -z "$IDS" ]; then
    echo "ERROR:Message ID is required"
    exit 1
fi

# Build the AppleScript dynamically
if [ "$INCLUDE_CONTENT" = "true" ]; then
    CONTENT_PART='set msgContent to content of msg'
else
    CONTENT_PART='set msgContent to ""'
fi

if [ -n "$ACCOUNT" ]; then
    ACCOUNT_PART="mailbox \"$MAILBOX\" of account \"$ACCOUNT\""
else
    ACCOUNT_PART="mailbox \"$MAILBOX\""
fi

osascript <<EOF
tell application "Mail"
    set results to ""
    set targetIds to {$IDS}
    try
        set theMailbox to $ACCOUNT_PART
        set allMessages to messages of theMailbox

        repeat with targetId in targetIds
            repeat with msg in allMessages
                if id of msg is targetId then
                    set msgId to id of msg
                    set msgSubject to subject of msg
                    set msgSender to sender of msg
                    set msgDate to date sent of msg
                    set msgRead to read status of msg
                    $CONTENT_PART

                    -- Get recipients
                    set toList to ""
                    repeat with r in to recipients of msg
                        set toList to toList & address of r & ","
                    end repeat
                    if toList is not "" then set toList to text 1 thru -2 of toList

                    set ccList to ""
                    repeat with r in cc recipients of msg
                        set ccList to ccList & address of r & ","
                    end repeat
                    if ccList is not "" then set ccList to text 1 thru -2 of ccList

                    set bccList to ""
                    repeat with r in bcc recipients of msg
                        set bccList to bccList & address of r & ","
                    end repeat
                    if bccList is not "" then set bccList to text 1 thru -2 of bccList

                    set results to results & msgId & "<<>>" & msgSubject & "<<>>" & msgSender & "<<>>" & toList & "<<>>" & ccList & "<<>>" & bccList & "<<>>" & (msgDate as string) & "<<>>" & msgRead & "<<>>" & msgContent & "|||"
                    exit repeat -- Found the message, move to next ID
                end if
            end repeat
        end repeat
    on error errMsg
        return "ERROR:" & errMsg
    end try
    return results
end tell
EOF
