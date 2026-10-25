# Slack

Talk to your own bb from Slack. One team Slack app named `bb` is installed
once; a DM to it reaches the server of the Slack user who sent it, which runs
a bb thread and replies in the same Slack thread.

A DM and a channel mention of the app both reach the server of the Slack user
who sent them. Per-message "Alice's bb" naming is a later step.

## How it fits together

bb-gate-hooks (`bb-gate/docs/hooks.md`, "Slack agent") holds the app's
credentials and routes each event; this plugin holds only the developer's own
sign-in token. There is no bot token, no client secret and no cluster access
on the pod.

- **Sign-in.** Settings → Plugins → Slack → **Sign in with Slack** sends the
  browser to Slack through bb-gate-hooks, which mints a PKCE state bound to
  this server's connection. Slack sends the browser back to this plugin's
  callback at
  `/api/v1/plugins/slack/http/signin/callback`; the router's tsjwt sends it to
  the browser owner's own server. The plugin asks bb-gate-hooks to exchange
  the code (the client secret never leaves the service), stores the returned
  user token in a secret setting, and presents it at `POST /v1/identify`. The
  service reads the token's own Slack user and binds it to this server's
  stream. The token also carries the user scopes `channels:read` and
  `groups:read`, so the settings page can list the channels *this developer*
  can see — never what the bot can see.
- **The wake.** A DM from that user arrives as `event: session`,
  `source: "slack"` on the same SSE stream the Linear plugin uses. The plugin
  maps the conversation (`channel:thread`) to one bb thread: the first message
  spawns it, a follow-up is sent to it.
- **Replies.** The plugin never holds the bot token. `slack_reply` posts
  through bb-gate-hooks with the connection id and the text; the service posts
  as the app. `assistant.threads.setStatus` shows a thinking indicator while
  the turn runs, and the bb thread's title is pushed with
  `assistant.threads.setTitle`.
- **No reply.** If a turn that handled a wake ends without calling
  `slack_reply`, the plugin posts one error reply itself, so every message
  gets an answer.

## Settings

| Setting | What it is |
|---|---|
| Slack sign-in token | Filled in by Sign in with Slack. A secret; do not edit or paste by hand. |
| Project | The bb project a Slack conversation starts its thread in when the channel map has no entry for it. Empty uses the personal project, or the first project when this server has none. |
| Channel map | A JSON array of `{"channel":"C…","project":"name"}` entries. A channel is a Slack channel id (`C…`/`G…`), never a name, so renaming a channel does not move its entry; the reserved key `dm` is a direct message with the app. A channel or DM with no entry uses the Project above. The settings page edits the same map as a list: the channel box is a typeahead over the channels the signed-in developer can see, showing `#name` and a lock for a private channel, and storing the id. A pasted `C…`/`G…` id and `dm` are still accepted. A channel the app's bot is not a member of is flagged "bb is not in this channel yet; invite it". |

The channel typeahead calls Slack's `conversations.list` directly with the
stored user token, paginated and cached in memory for a few minutes per
server; filtering by name is local. A still-valid OpenID token from a sign-in
before this change cannot list channels, so the picker says "Sign in again to
search channels" and falls back to the id box.

A DM typed while the assistant pane is showing a mapped channel uses that
channel's project: the plugin remembers the latest
`assistant_thread_context_changed` channel per DM conversation and consults it
before the `dm` entry. Context is read only when a thread is started; an
existing Slack thread keeps its bb thread.

Words from anyone but the owner never run a turn. A channel mention by someone
else is held under a short id and the owner releases it by mentioning the app
with `confirm <id>`; only then does the text reach a bb thread.

**Sign out** forgets the token and reconnects the stream, so the service drops
the identity bound to the old connection.

## By hand (a Slack admin)

The Slack app itself, its scopes, the events URL and the redirect URL are set
up by hand as described in `bb-gate/README.md`. No agent creates or sees the
signing secret, bot token or OAuth client secret; they are sealed with
`bb-gate/scripts/seal-hooks`.

## Tools

| Tool | What it does |
|---|---|
| `slack_reply` | Post the one reply on the Slack conversation that woke this thread. The service holds the bot token; the request carries only the connection id and the text. |

## Other people's text

The map decides where a thread starts, not whose words it trusts. A channel
mention by someone other than the server's owner is parked (no turn runs) and
the plugin posts one reply asking the owner to mention it with `confirm <id>`; a
mention by the owner that names the id releases exactly one held message into
the thread. A vague owner reply while requests wait re-asks for the id instead
of running a turn.
