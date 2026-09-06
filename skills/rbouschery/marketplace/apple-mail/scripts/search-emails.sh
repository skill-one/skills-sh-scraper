#!/bin/bash
# Search emails by query
# Usage: ./search-emails.sh <query> [account] [mailbox] [limit]
# Output: id<<>>subject<<>>sender<<>>to<<>>cc<<>>bcc<<>>dateSent<<>>isRead|||...

QUERY="${1:-}"
ACCOUNT="${2:-}"
MAILBOX="${3:-}"
LIMIT="${4:-10}"

if [ -z "$QUERY" ]; then
    echo "ERROR:Search query is required"
    exit 1
fi

# Escape double quotes in query
ESCAPED_QUERY=$(echo "$QUERY" | sed 's/"/\\"/g')

# Build mailbox selection part
if [ -n "$ACCOUNT" ] && [ -n "$MAILBOX" ]; then
    MAILBOX_PART="{mailbox \"$MAILBOX\" of account \"$ACCOUNT\"}"
elif [ -n "$ACCOUNT" ]; then
    MAILBOX_PART="mailboxes of account \"$ACCOUNT\""
elif [ -n "$MAILBOX" ]; then
    MAILBOX_PART="{mailbox \"$MAILBOX\"}"
else
    MAILBOX_PART="inbox"
fi

osascript <<EOF
tell application "Mail"
    set results to ""
    set foundCount to 0
    set searchQuery to "$ESCAPED_QUERY"

    try
        set searchMailboxes to $MAILBOX_PART
        repeat with mb in searchMailboxes
            if foundCount >= $LIMIT then exit repeat

            set msgList to (messages of mb whose subject contains searchQuery or sender contains searchQuery or content contains searchQuery)
            repeat with msg in msgList
                if foundCount >= $LIMIT then exit repeat

                set msgId to id of msg
                set msgSubject to subject of msg
                set msgSender to sender of msg
                set msgDate to date sent of msg
                set msgRead to read status of msg

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

                set results to results & msgId & "<<>>" & msgSubject & "<<>>" & msgSender & "<<>>" & toList & "<<>>" & ccList & "<<>>" & bccList & "<<>>" & (msgDate as string) & "<<>>" & msgRead & "|||"
                set foundCount to foundCount + 1
            end repeat
        end repeat
    on error errMsg
        return "ERROR:" & errMsg
    end try
    return results
end tell
EOF
