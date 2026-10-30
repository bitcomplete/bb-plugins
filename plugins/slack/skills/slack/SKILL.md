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

A DM and a channel mention of the app both wake the server of the Slack user
who sent them. A channel mention by someone other than the server's owner is
held: no turn runs, and the plugin posts one reply asking the owner to
`confirm <id>`. Only the owner's mention that names the id releases the held
text into a thread. Which bb project a conversation starts in is chosen from
the routing map (Settings → Plugins → Slack): a mention in a mapped channel
uses that channel's project; everything else, DMs included, uses the fallback.
The sign-in token and the map live in the plugin's own storage, not in bb's
settings table.

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
- The session is leased to this server: the wake carries an opaque capability
  that the plugin echoes to `POST /v1/subscribe`, and the lease is renewed at
  half its life. Reply rights therefore survive a restart of bb-gate-hooks and
  are not limited to a day.
- If the turn that handled a wake ends without calling `slack_reply`, the
  plugin posts one error reply itself, so the developer is not left waiting.
- While the turn runs the plugin sets the Slack assistant status to
  "is thinking…", and it pushes the bb thread's title to the Slack
  conversation, so the title comes from bb, not from Slack.

## Diagnosing

- "This thread is not answering a Slack conversation": the wake has no session
  mapped to this thread, or the bb thread it was mapped to was deleted and the
  mapping was forgotten. A new Slack message starts a new thread.
- "bb-gate-hooks refused: this Slack conversation is not routed to this
  server's Slack user": the service did not route the session here and no
  live lease holds it. Nothing was posted.
- "not connected to bb-gate-hooks": the server's stream is reconnecting, or
  the server has no `BB_HOOKS_URL`. Try again, or ask the developer to check
  Settings → Plugins → Slack.
- Settings → Plugins → Slack shows the connection as "Signed in as …" and the
  routing map. Sign out forgets the token; sign in again with Sign in with
  Slack.
- "confirm r-…": a mention from anyone but the owner does not run a turn. The
  plugin replies with the id to confirm; the owner mentions the app with
  `confirm <id>` to release it. A vague reply while a request waits re-asks for
  the id.
