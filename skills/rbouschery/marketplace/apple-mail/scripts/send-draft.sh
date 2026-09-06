#!/bin/bash
# Send the front-most draft (compose window) in Apple Mail
# Usage: ./send-draft.sh
# Output: Success or error message

osascript <<'EOF'
tell application "Mail"
    try
        set outgoingCount to count of outgoing messages
        if outgoingCount is 0 then
            return "ERROR:No draft message found. Create a draft first using create-draft.sh or create-reply-draft.sh."
        end if

        set theDraft to outgoing message 1
        send theDraft

        return "Draft sent successfully"
    on error errMsg
        return "ERROR:" & errMsg
    end try
end tell
EOF
