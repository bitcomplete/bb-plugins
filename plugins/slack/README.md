# Slack

Talk to your own bb from Slack. One team Slack app named `bb` is installed
once; a DM to it reaches the server of the Slack user who sent it, which runs
a bb thread on the first message and replies in the same Slack thread.

A DM and the first channel mention in a conversation reach the server of the
Slack user who sent them. The first routed mention in a conversation sets its
owner, and a later mention by someone else goes to that same server, held for
the owner to confirm (see "Other people's text"). A reply in a channel thread
bb is already part of is routed the same way even without an `@bb` tag, but it
is a continuation rather than a request: it is delivered to the bb thread and
does not owe a reply. Posting as "Alice's bb" per message is a separate later
step.

A message sent while bb is working **steers the current work**: it is
injected into the running turn instead of queueing behind it, so a correction
typed mid-turn is read as a correction or addition, and the turn's one reply
covers both Slack messages. A message to an idle thread starts a turn as
usual.

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
  user token in plugin storage, and presents it at `POST /v1/identify`. The
  service reads the token's own Slack user and binds it to this server's
  stream. The token also carries the user scopes `channels:read` and
  `groups:read`, so the settings page can list the channels *this developer*
  can see — never what the bot can see.
- **The wake.** A DM from that user arrives as `event: session`,
  `source: "slack"` on the same SSE stream the Linear plugin uses. The plugin
  maps the conversation (`channel:thread`) to one bb thread: the first message
  spawns it, a follow-up is sent to it as a steer (`mode: "steer"`) — it joins
  the turn already running, or starts one when the thread is idle. Opening the
  assistant pane sends `assistant_thread_started`, which posts a canned
  one-line greeting and starts no bb thread; the first real message then spawns
  the thread as usual.
- **Replies.** The plugin never holds the bot token. `slack_reply` posts
  through bb-gate-hooks with the connection id and the text; the service posts
  as the app. The text may be Markdown: the plugin converts it to Slack mrkdwn
  before posting (see "Tools"). `assistant.threads.setStatus` shows a thinking
  indicator while the turn runs, and the bb thread's title is pushed with
  `assistant.threads.setTitle`.
- **Ownership.** Each wake carries an opaque capability for the session, and
  the plugin echoes it to `POST /v1/subscribe` after every `hello` and at half
  the lease's life. The lease is the owner of record, so reply rights survive a
  restart of bb-gate-hooks and a gap longer than the old 24-hour route window.
  Archiving the bb thread drops the session from the renewal set. A session the
  service says another server owns is logged and gets a best-effort backstop
  reply; the other server's live lease makes the service refuse that reply, so
  the log line is the reliable half.
- **No reply.** If a turn that handled a tagged wake ends without calling
  `slack_reply`, the plugin posts one error reply itself, so every tagged
  message gets an answer. A message that needs no answer (a thanks, or one bb
  should not act on) is acknowledged with `slack_ack` instead, which counts the
  wake as answered and posts nothing, so no error reply fires. A follow-up
  delivered as a steer joins the running turn, so its reply is the turn's one
  reply and a silent turn still gets a single backstop, not one per message. An
  untagged reply in a followed thread does not owe a reply, so a silent turn
  there posts nothing.

## Settings

The plugin declares no bb settings: the Slack section under
Settings → Plugins → Slack manages everything, and the sign-in token and the
routing map live in the plugin's own storage (`bb.storage.kv`), not in the
settings table. The token is never sent to the settings page or the status RPC.

| In the Slack section | What it is |
|---|---|
| Sign in with Slack / Sign out | The developer's own Slack sign-in. The token it returns proves who they are and reads the channel list they can see. |
| Routing map | A pinned first row, **Everything else**, then a row per channel. A mention in a mapped channel starts its thread in that channel's project; everything else, DMs included, starts in the project on the first row. The channel is a Slack channel id (`C…`/`G…`), never a name, so renaming a channel does not move its entry. The editor refuses to save without a fallback. A fallback or row naming a project this server does not have is skipped at run time — the conversation falls to the personal project, or the first one — and the page warns beside the row, since one map is meant to work on every server. A row whose project has no checkout or environment on a connected machine is warned about too: its thread runs on whichever connected machine is available, which may not have the project. |

The channel typeahead calls Slack's `conversations.list` directly with the
stored user token, paginated and cached in memory for a few minutes per
server; filtering by name is local. A still-valid OpenID token from a sign-in
before this change cannot list channels, so the picker says "Sign in again to
search channels" and falls back to the id box. A channel the app's bot is not a
member of gets a prompt under its row, "bb is not in #name yet. Add bb to this
channel?", with an **Add bb** button: the plugin asks bb-gate-hooks
(`POST /v1/slack/bot/join`), which joins with the bot token it holds, so the
pod never needs one. Slack lets a bot join only public channels by itself, so
for a private channel the prompt says to type `/invite @bb` in Slack instead,
and so does every refusal (an app installed without the `channels:join` bot
scope, an older service without the endpoint). The bot's own join raises no
prompt in Slack and writes nothing to the routing map.

Words from anyone but the owner never run a turn. A channel mention by someone
else is held under a short id and the owner releases it by mentioning the app
with `confirm <id>`; only then does the text reach a bb thread.

**Sign out** deletes the token from plugin storage and reconnects the stream,
so the service drops the identity bound to the old connection.

### Upgrade

The first start after this version moves the old `token`, `project` and
`channels` settings into plugin storage. The old `channels` array becomes the
map's channel rows, and the fallback is the old `dm` entry if there was one,
else the old `project` setting; when both existed and differed, `dm` won. The
old `dm` entry is dropped from the rows. Only the old token setting is cleared;
the old `project` and `channels` settings are left in place, so rolling back to
the previous version asks the developer to sign in again and then applies the
old project and channels settings.

## Continuing a thread without tagging bb

Once the app is subscribed to `message.channels` and `message.groups`, a reply
inside a channel thread bb is already part of is routed to the conversation's
owner's server even when it does not tag `@bb`. The wake says the message was
posted without addressing bb and tells the turn to reply only when the message
is for bb. Such a reply is delivered to the bb thread but does not owe a reply:
it is not counted for the one-reply-per-message rule, and a turn that ends
silently posts no error reply. An untagged reply from someone other than the
owner is held for the owner's confirmation exactly like an untrusted mention.

A thread only becomes followed once bb has been tagged or mentioned in it; a
thread bb is not part of is dropped by bb-gate-hooks, in memory, with no text,
user or channel logged or stored. The feature is **inert until a Slack admin
does two by-hand steps** on the team app:

1. **OAuth & Permissions → Bot Token Scopes**: add `channels:history` and
   `groups:history`, then **Reinstall to Workspace**.
2. **Event Subscriptions → Subscribe to bot events**: add `message.channels`
   and `message.groups`.

Until both are done, no untagged reply reaches bb. After the reinstall, the
service receives every message in every channel the bot is in; it acks and
drops everything that is not in a followed thread.

## Editing and deleting a message

bb-gate-hooks routes an edit or a deletion of a DM to the conversation's
owner as a correction carrying the original message's `ts`. The plugin keeps
the last few wakes per conversation keyed by that `ts` and applies the
correction to the wake it matches:

- **Still queued** (its turn has not started): an edit rewrites the queued
  message in place, and a deletion removes it from the queue. A removed wake
  owes no reply.
- **Turn started or finished**: an edit steers the thread with the original
  text and the new one, and the correction owes its own reply if the turn has
  already replied; a deletion steers with "that message was deleted; disregard
  it" and owes no reply.
- A correction of a message that never produced a wake (never routed, or older
  than the last few) is dropped.
- An edit from someone other than the owner follows the untrusted path: the
  new text is held for the owner's confirmation, exactly like the original
  message.

## By hand (a Slack admin)

The Slack app itself, its scopes, the events URL and the redirect URL are set
up by hand as described in `bb-gate/README.md`. No agent creates or sees the
signing secret, bot token or OAuth client secret; they are sealed with
`bb-gate/scripts/seal-hooks`.

## Tools

| Tool | What it does |
|---|---|
| `slack_reply` | Post the one reply on the Slack conversation that woke this thread. The service holds the bot token; the request carries only the connection id and the text. The text may be Markdown (`**bold**`, `# Heading`, `- item`, `[label](url)`, fenced code): the plugin converts it to Slack mrkdwn before posting. |
| `slack_ack` | Count the wake as answered without posting anything, for a message that needs no answer (a thanks, or one bb should not act on), so no error reply fires. It is not for skipping work that was asked for; answer a request with `slack_reply`. |

## Other people's text

The map decides where a thread starts, not whose words it trusts. A channel
mention by someone other than the server's owner — a later mention in a
conversation the owner's first mention routed — is delivered to the owner's
server marked untrusted and parked (no turn runs); the plugin posts one reply
asking the owner to mention it with `confirm <id>`, and a mention by the owner
that names the id releases exactly one held message into the thread. A vague
owner reply while requests wait re-asks for the id instead of running a turn.
