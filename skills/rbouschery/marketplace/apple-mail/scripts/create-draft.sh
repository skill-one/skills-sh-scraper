#!/bin/bash
# Create a draft email
# Usage: ./create-draft.sh <subject> <body> [to] [cc] [bcc] [from]
# For multiple recipients, pass comma-separated: "a@example.com,b@example.com"
# Output: Success or error message

SUBJECT="${1:-}"
BODY="${2:-}"
TO="${3:-}"
CC="${4:-}"
BCC="${5:-}"
FROM="${6:-}"

if [ -z "$SUBJECT" ]; then
    echo "ERROR:Subject is required"
    exit 1
fi

if [ -z "$BODY" ]; then
    echo "ERROR:Body is required"
    exit 1
fi

# Escape special characters for AppleScript
escape_for_applescript() {
    echo "$1" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g' | tr '\n' '\r' | sed 's/\r/\\n/g'
}

ESCAPED_SUBJECT=$(escape_for_applescript "$SUBJECT")
ESCAPED_BODY=$(escape_for_applescript "$BODY")

# Build recipient commands
build_recipients() {
    local TYPE="$1"
    local ADDRESSES="$2"
    local RESULT=""

    IFS=',' read -ra ADDR_ARRAY <<< "$ADDRESSES"
    for addr in "${ADDR_ARRAY[@]}"; do
        addr=$(echo "$addr" | xargs)  # trim whitespace
        if [ -n "$addr" ]; then
            RESULT="$RESULT
        make new $TYPE recipient at end of $TYPE recipients with properties {address:\"$addr\"}"
        fi
    done
    echo "$RESULT"
}

TO_RECIPIENTS=""
CC_RECIPIENTS=""
BCC_RECIPIENTS=""
FROM_PART=""

if [ -n "$TO" ]; then
    TO_RECIPIENTS=$(build_recipients "to" "$TO")
fi

if [ -n "$CC" ]; then
    CC_RECIPIENTS=$(build_recipients "cc" "$CC")
fi

if [ -n "$BCC" ]; then
    BCC_RECIPIENTS=$(build_recipients "bcc" "$BCC")
fi

if [ -n "$FROM" ]; then
    FROM_PART=", sender:\"$FROM\""
fi

osascript <<EOF
tell application "Mail"
    set newMessage to make new outgoing message with properties {subject:"$ESCAPED_SUBJECT", content:"$ESCAPED_BODY", visible:true$FROM_PART}
    tell newMessage
        $TO_RECIPIENTS
        $CC_RECIPIENTS
        $BCC_RECIPIENTS
    end tell
    -- Draft is created by leaving the compose window open
    return "Draft created successfully"
end tell
EOF
