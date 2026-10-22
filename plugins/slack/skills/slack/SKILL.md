---
name: slack
description: Reply in Slack on the conversation that woke a bb thread, or diagnose why a Slack DM did not reach the Slack plugin.
---

# Slack

The `slack` plugin lets a developer talk to their own bb from Slack. A DM to
the team's `bb` app reaches the server of the Slack user who sent it as an
`event: session` wake; the plugin starts (or continues) one bb thread per
Slack conversation and posts the reply back through bb-gate-hooks, which holds
the app's bot token. The pod never holds a Slack bot credential.

Phase 1 is DMs only: the asker is always the server's owner, so the
owner-confirmation path other people's text needs is not exercised yet. Text
from anyone but the proven owner is still marked untrusted in the wake.

## Replying

A Slack wake reaches a thread as a message naming the session
(`channel:thread`) and telling you to use `slack_reply`. Post exactly one
reply per Slack message:

| Tool | Use it to |
|---|---|
| `slack_reply` | Post the reply on the Slack conversation that woke this thread. Pass `text` (Slack's mrkdwn) and, only when a thread has more than one conversation, the `session` from the wake. |

- The reply is posted by bb-gate-hooks as the app; the tool sends only the
  connection id and the text, so never put a token or secret in it.
- Each Slack message gets one reply. A second `slack_reply` for the same
  message is refused; a new Slack message is a new wake and can be answered.
- If the turn that handled a wake ends without calling `slack_reply`, the
  plugin posts one error reply itself, so the developer is not left waiting.
- While the turn runs the plugin sets the Slack assistant status to
  "is thinking…", and it pushes the bb thread's title to the Slack
  conversation, so the title comes from bb, not from Slack.

## Diagnosing

- "This thread is not answering a Slack conversation": the wake has no session
  mapped to this thread, or the bb thread it was mapped to was deleted and the
  mapping was forgotten. A new Slack message starts a new thread.
- "bb-gate-hooks refused: this Slack conversation was not routed to this
  server's Slack user": the service did not route the session here, its last
  message was more than a day ago, or the service restarted. Nothing was
  posted.
- "not connected to bb-gate-hooks": the server's stream is reconnecting, or
  the server has no `BB_HOOKS_URL`. Try again, or ask the developer to check
  Settings → Plugins → Slack.
- Settings → Plugins → Slack shows the connection as "Signed in as …". Sign
  out forgets the token; sign in again with Sign in with Slack.
