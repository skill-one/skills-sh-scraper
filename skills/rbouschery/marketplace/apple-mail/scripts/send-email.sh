#!/bin/bash
# Send an email
# Usage: ./send-email.sh <to> <subject> <body> [cc] [bcc] [from]
# For multiple recipients, pass comma-separated: "a@example.com,b@example.com"
# Output: Success or error message

TO="${1:-}"
SUBJECT="${2:-}"
BODY="${3:-}"
CC="${4:-}"
BCC="${5:-}"
FROM="${6:-}"

if [ -z "$TO" ]; then
    echo "ERROR:Recipient (to) is required"
    exit 1
fi

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

TO_RECIPIENTS=$(build_recipients "to" "$TO")
CC_RECIPIENTS=""
BCC_RECIPIENTS=""
FROM_PART=""

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
    set newMessage to make new outgoing message with properties {subject:"$ESCAPED_SUBJECT", content:"$ESCAPED_BODY"$FROM_PART}
    tell newMessage
        $TO_RECIPIENTS
        $CC_RECIPIENTS
        $BCC_RECIPIENTS
    end tell
    send newMessage
    return "Message sent successfully"
end tell
EOF
