# AppleScript Patterns for Apple Mail

This document contains advanced AppleScript patterns for Apple Mail automation. Use these patterns when the provided scripts don't cover your specific use case.

## Execution

All AppleScript code should be executed via `osascript`:

```bash
osascript <<'EOF'
tell application "Mail"
    -- AppleScript code here
end tell
EOF
```

Or with variable interpolation (use `<<EOF` without quotes):

```bash
osascript <<EOF
tell application "Mail"
    set theMailbox to mailbox "$MAILBOX" of account "$ACCOUNT"
end tell
EOF
```

## Output Delimiters

For structured output that's easy to parse:
- `<<>>` separates fields within a record
- `|||` separates multiple records
- `ERROR:` prefix indicates errors

## Core Patterns

### Accessing Accounts

```applescript
tell application "Mail"
    -- List all accounts
    set accountList to {}
    repeat with acc in accounts
        set end of accountList to name of acc
    end repeat
    return accountList
end tell
```

### Accessing Mailboxes

```applescript
tell application "Mail"
    -- List mailboxes for specific account
    set acc to account "iCloud"
    set mailboxList to {}
    repeat with mb in mailboxes of acc
        set end of mailboxList to name of mb
    end repeat
    return mailboxList
end tell
```

### Referencing Mailboxes

```applescript
-- By account and name
set theMailbox to mailbox "INBOX" of account "iCloud"

-- Just by name (first matching)
set theMailbox to mailbox "INBOX"

-- Special mailboxes
set theInbox to inbox  -- Global inbox
```

### Getting Messages

```applescript
tell application "Mail"
    set theMailbox to mailbox "INBOX" of account "iCloud"

    -- Get all messages
    set allMsgs to messages of theMailbox

    -- Get first N messages
    set msgCount to count of messages of theMailbox
    if msgCount > 10 then set msgCount to 10
    repeat with i from 1 to msgCount
        set msg to message i of theMailbox
        -- process msg
    end repeat
end tell
```

### Filtering Messages

```applescript
tell application "Mail"
    set theMailbox to mailbox "INBOX"

    -- Unread messages only
    set unreadMsgs to (messages of theMailbox whose read status is false)

    -- Messages from specific sender
    set fromMsgs to (messages of theMailbox whose sender contains "example@email.com")

    -- Messages with subject containing text
    set subjectMsgs to (messages of theMailbox whose subject contains "meeting")

    -- Messages by date (newer than date)
    set recentMsgs to (messages of theMailbox whose date sent > (current date) - 7 * days)
end tell
```

### Message Properties

```applescript
tell application "Mail"
    set msg to message 1 of mailbox "INBOX"

    -- Basic properties
    set msgId to id of msg
    set msgSubject to subject of msg
    set msgSender to sender of msg
    set msgDate to date sent of msg
    set msgRead to read status of msg
    set msgContent to content of msg

    -- Recipients
    set toRecipients to to recipients of msg
    set ccRecipients to cc recipients of msg
    set bccRecipients to bcc recipients of msg

    -- Get email addresses from recipients
    set toList to ""
    repeat with r in to recipients of msg
        set toList to toList & address of r & ","
    end repeat
    -- Remove trailing comma
    if toList is not "" then set toList to text 1 thru -2 of toList
end tell
```

### Finding Message by ID

```applescript
tell application "Mail"
    set theMailbox to mailbox "INBOX"
    set theMessage to (first message of theMailbox whose id is 12345)
end tell
```

### Creating and Sending Messages

```applescript
tell application "Mail"
    -- Create new message
    set newMessage to make new outgoing message with properties {subject:"Hello", content:"Body text here", visible:true}

    -- Add recipients
    tell newMessage
        make new to recipient at end of to recipients with properties {address:"to@example.com"}
        make new cc recipient at end of cc recipients with properties {address:"cc@example.com"}
        make new bcc recipient at end of bcc recipients with properties {address:"bcc@example.com"}
    end tell

    -- Send immediately
    send newMessage

    -- Or leave as draft (just don't call send)
end tell
```

### Replying to Messages

```applescript
tell application "Mail"
    set theMessage to message 1 of mailbox "INBOX"

    -- Reply to sender only
    set replyMsg to reply theMessage with opening window

    -- Reply to all
    set replyAllMsg to reply theMessage with opening window and reply to all

    -- Set reply content
    set content of replyMsg to "Thanks for your message!"
end tell
```

### Forwarding Messages

```applescript
tell application "Mail"
    set theMessage to message 1 of mailbox "INBOX"

    -- Forward message
    set fwdMsg to forward theMessage with opening window

    -- Add recipient
    tell fwdMsg
        make new to recipient at end of to recipients with properties {address:"forward@example.com"}
    end tell
end tell
```

### Moving Messages

```applescript
tell application "Mail"
    set theMessage to message 1 of mailbox "INBOX"
    set targetMailbox to mailbox "Archive" of account "iCloud"

    move theMessage to targetMailbox
end tell
```

### Deleting Messages

```applescript
tell application "Mail"
    set theMessage to message 1 of mailbox "INBOX"

    -- Move to trash
    delete theMessage

    -- Permanently delete (requires getting from trash first)
    -- delete theMessage  -- when already in trash
end tell
```

### Marking Messages

```applescript
tell application "Mail"
    set theMessage to message 1 of mailbox "INBOX"

    -- Mark as read
    set read status of theMessage to true

    -- Mark as unread
    set read status of theMessage to false

    -- Flag/unflag
    set flagged status of theMessage to true
    set flagged status of theMessage to false
end tell
```

### Unread Count

```applescript
tell application "Mail"
    -- Specific mailbox
    return unread count of mailbox "INBOX" of account "iCloud"

    -- All mailboxes for account
    set total to 0
    repeat with mb in mailboxes of account "iCloud"
        set total to total + (unread count of mb)
    end repeat
    return total
end tell
```

### Searching Messages

```applescript
tell application "Mail"
    set theMailbox to mailbox "INBOX"
    set searchQuery to "meeting"

    -- Search in subject, sender, and content
    set foundMsgs to (messages of theMailbox whose subject contains searchQuery or sender contains searchQuery or content contains searchQuery)

    -- Limit results
    set maxResults to 10
    set foundCount to count of foundMsgs
    if foundCount > maxResults then set foundCount to maxResults

    repeat with i from 1 to foundCount
        set msg to item i of foundMsgs
        -- process msg
    end repeat
end tell
```

### Working with Outgoing Messages (Drafts)

```applescript
tell application "Mail"
    -- Count drafts
    set draftCount to count of outgoing messages

    -- Get first draft
    if draftCount > 0 then
        set theDraft to outgoing message 1

        -- Send it
        send theDraft
    end if
end tell
```

## Error Handling

```applescript
tell application "Mail"
    try
        set theMailbox to mailbox "INBOX" of account "NonexistentAccount"
        -- ... operations
    on error errMsg
        return "ERROR:" & errMsg
    end try
end tell
```

## String Escaping

When passing variables containing special characters:

```applescript
-- Escape double quotes
set escapedText to "He said \"hello\""

-- Newlines in content
set bodyText to "Line 1" & return & "Line 2"

-- Or with escaped newlines from shell
set bodyText to "Line 1\nLine 2"  -- won't work directly
set bodyText to "Line 1" & return & "Line 2"  -- correct
```

## Building Output Strings

```applescript
-- Concatenate with delimiters
set results to ""
repeat with msg in messages of mailbox "INBOX"
    set msgId to id of msg
    set msgSubject to subject of msg
    set results to results & msgId & "<<>>" & msgSubject & "|||"
end repeat
return results
```

## Common Issues and Solutions

### Timeout Issues
Long operations may timeout. Increase timeout in shell:
```bash
osascript -e "..." &  # Run in background
# or
timeout 60 osascript <<'EOF'
...
EOF
```

### Permission Errors
First run will prompt for Automation permissions in System Preferences > Security & Privacy > Privacy > Automation.

### Account Names with Special Characters
Use exact account name as shown in Mail.app preferences.

### Empty Results
Check that Mail.app is running and has accounts configured:
```applescript
tell application "Mail"
    if (count of accounts) is 0 then
        return "ERROR:No email accounts configured"
    end if
end tell
```

### Finding the Right Archive Mailbox
Different email providers use different names:
- Apple/iCloud: "Archive"
- Gmail: "All Mail"
- Outlook: "Archive"
- Generic: "Archives"

```applescript
-- Try common archive names
set archiveMailbox to missing value
repeat with mb in mailboxes of theAccount
    if name of mb is "Archive" or name of mb is "Archives" or name of mb is "All Mail" then
        set archiveMailbox to mb
        exit repeat
    end if
end repeat
```

## Advanced Patterns

### Batch Operations

```applescript
tell application "Mail"
    set theMailbox to mailbox "INBOX"
    set unreadMsgs to (messages of theMailbox whose read status is false)

    -- Mark all as read
    repeat with msg in unreadMsgs
        set read status of msg to true
    end repeat
end tell
```

### Getting Attachments Info

```applescript
tell application "Mail"
    set msg to message 1 of mailbox "INBOX"
    set attachList to mail attachments of msg

    repeat with att in attachList
        set attName to name of att
        set attSize to file size of att
        -- Note: Saving attachments requires additional permissions
    end repeat
end tell
```

### Checking Mail Status

```applescript
tell application "Mail"
    -- Check if Mail is running
    if it is running then
        -- Check connection status
        repeat with acc in accounts
            set accName to name of acc
            -- Note: No direct way to check connection status
        end repeat
    end if
end tell
```

## Integration Tips

1. **Always use error handling** - AppleScript can fail for many reasons
2. **Use heredocs for complex scripts** - Easier to read and maintain
3. **Escape user input** - Especially quotes and backslashes
4. **Parse output carefully** - Handle empty results and edge cases
5. **Test with real data** - Account names and mailbox names vary by provider
