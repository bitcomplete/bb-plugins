---
name: thread-briefs
description: Configure or diagnose the Thread briefs plugin — the per-thread goal/state/next-step brief, its summarizer endpoint, the sidebar glyphs, and the manual stage override.
---

# Thread briefs

Keeps one short, durable brief per thread — goal, current state, next step,
blocked on, constraints — generated outside the working chat so the thread's own
context stays clean. Briefs surface as a glyph on the sidebar row and in full
behind the **Brief** control in the thread header.

## Settings

Set these with `bb plugin config thread-briefs set <key> <value>`.

| Key | Default | What it does |
| --- | --- | --- |
| `baseUrl` | `https://api.openai.com/v1` | OpenAI-compatible API root. `/chat/completions` is appended; a trailing slash is fine. |
| `apiKey` | _(unset, secret)_ | Bearer token for that endpoint. The plugin reports `needs-configuration` until it is set. |
| `model` | `gpt-4o-mini` | Model used for summarizing. Any small instruction-following model works. |
| `jsonMode` | `true` | Send `response_format: {type: "json_object"}`. Turn **off** for endpoints that reject it (many local servers do). |
| `quietSeconds` | `120` | How long a thread must be quiet before it is summarized. |

The key is a secret setting, so it stays on the server and is never sent to the
frontend.

## When a brief is regenerated

1. `thread.idle` fires at every turn boundary and starts a `quietSeconds`
   debounce for that thread. `thread.active` cancels it — a thread mid-burst is
   not summarized until the burst stops.
2. A `*/10 * * * *` sweep is the backstop for activity whose `thread.idle` never
   arrived (server restart, plugin reload, a turn that ended in `error`). It only
   enqueues threads whose stored cursor is behind the thread's own.
3. Before spending a request, the summarizer compares the thread's
   `conversationOutline().maxSeq` against `lastActivitySeen` and skips threads
   that have not actually moved.

Re-summarize is available in the header popover; it bypasses the debounce.

Hidden threads (plugin workers) and deleted threads never get briefs.

**Briefs are not backfilled.** The sweep will give a briefless thread its first
brief only if it was active in the last 24 hours (`BACKFILL_WINDOW_MS`).
Anything dormant longer stays briefless and the header popover says so, with a
**Summarize now** button. This is deliberate: without the bound, every briefless
thread would be re-enqueued on every sweep forever — an unbounded burst of
requests the first time a key is configured, and an endless retry for any thread
whose summary keeps failing.

So a thread reports `summarizing` only while work is genuinely debounced,
queued, or in flight; otherwise it reports `absent`, which the UI renders as an
offer rather than a spinner. A failed summary drops back to `absent`.

## Stage and status

`stage` is a semantic judgement from the transcript: discovery, planning,
implementation, review. Pick a stage by hand in the header popover to override
it; the override is anchored to the thread's activity cursor and retires itself
on the next real turn. Clicking the active manual stage clears it.

`status` is derived mechanically, so it stays correct between summaries:

- `nextStep` empty → **done**
- `blockedOn` non-empty → **waiting-on-other**
- the agent's last message ended in a question, or a pending interaction is
  live → **waiting-on-me**
- otherwise → **working**

The order matters: a thread with nothing left to do reads as done even if its
last turn ended in a question.

## Sidebar glyphs

bb paints a plugin row status **in place of** its own unsent-draft pencil, so
only the three states that are news get a glyph — a merely `working` thread
keeps bb's indicator:

| Status | Glyph |
| --- | --- |
| waiting-on-me | `MessageQuestion` |
| waiting-on-other | `Pause` |
| done | `CircleCheck`, success tone |

The pending-interaction half of that decision is computed in the client from
`experimental_useSidebarThreads()`, which is why no row needs a server round
trip to stay current.

## Diagnosing

- `bb plugin list` — service and schedule status, including the sweep's
  `last_status` / `last_error`.
- `bb plugin logs thread-briefs -n 50` — per-thread summarizer failures are
  logged as warnings and never crash the queue.
- No glyphs at all, but the header popover works: the bb client predates
  `experimental_setThreadRowStatus`, which the content script feature-detects.
- Briefs stuck on "Summarizing…": check `apiKey` is set and
  `bb plugin logs thread-briefs` for HTTP errors from `baseUrl`.
- "No brief for this thread yet" on an old thread is expected, not a fault —
  briefs are not backfilled past the 24h window. Use **Summarize now**.
