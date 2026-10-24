# Slack

Talk to your own bb from Slack. One team Slack app named `bb` is installed
once; a DM to it reaches the server of the Slack user who sent it, which runs
a bb thread and replies in the same Slack thread.

Phase 1 is DMs only. Channel mentions and per-message "Alice's bb" naming are
a later step; they bring in other people's text and need the owner's
confirmation path first.

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
  stream.
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
| Project | Which bb project a Slack conversation starts its thread in. Empty uses the personal project, or the first project when this server has none. |

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
