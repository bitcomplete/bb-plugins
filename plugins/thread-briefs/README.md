# Thread briefs

Threads in the bb sidebar are opaque — a truncated title, and re-entering one
means re-reading the transcript to remember what it was for. This plugin gives
every thread a short, durable **brief**, generated outside the working chat:

- **goal** — what the thread is actually trying to achieve
- **currentState** — what exists now, including half-done work
- **nextStep** — the single most concrete next action, or empty when done
- **blockedOn** — who or what it is waiting on
- **constraints** — facts learned in the thread that would break a naive re-plan

Plus a derived **stage** (discovery / planning / implementation / review) and
**status** (working / waiting-on-me / waiting-on-other / done).

## Install

```sh
bb plugin install git:https://github.com/bitcomplete/bb-plugins.git@main --plugin thread-briefs
bb plugin config thread-briefs set apiKey <key>
```

The summarizer talks to any OpenAI-compatible `/chat/completions` endpoint. See
[`skills/thread-briefs/SKILL.md`](skills/thread-briefs/SKILL.md) for every
setting, the regeneration triggers, and how to diagnose it.

## Where briefs show up

**Sidebar row** — a single glyph for the three statuses that are news:
waiting-on-you, blocked, and done. A thread that is merely being worked on keeps
bb's own indicator, because bb draws a plugin row status in place of its
unsent-draft pencil and displacing that everywhere would cost more than it says.

**Thread header** — a **Brief** control opens the full five fields (empty ones
are skipped), the derived status, a stage control for the manual override, and
Re-summarize. It works the same on mobile and desktop; nothing depends on hover.

Briefs are **never backfilled** — activity earns a brief. A thread that has been
dormant since before the plugin started stays briefless, and the popover says so
with **Summarize now** rather than showing a spinner that would never resolve.
Work on it again and it gets a brief like any other thread. The alternative —
summarizing every existing thread — is an unbounded burst the first time a key is
configured.

## How it is built

| Concern | Mechanism |
| --- | --- |
| Trigger | `bb.events.on("thread.idle")` + a per-thread quiet-period debounce, with a `*/10 * * * *` sweep as the backstop |
| Summarizer input | `threads.conversationOutline()` head + tail with the middle elided, `threads.output()` for the last message in full, and the previous brief |
| Storage | `bb.storage.kv`, one row per thread at `brief:<threadId>` |
| Sidebar glyph | a content script's `experimental_setThreadRowStatus`, fed by an `experimental_appOverlay` that owns the rpc + realtime subscription |
| Header UI | `experimental_threadHeaderAction` with a portalled popover |

### Why a content script rather than a list fork

bb exposes exactly one slot that owns thread rows,
`app.slots.experimental_threadList`, and it is *exclusive* — a plugin either
replaces the whole sidebar list or touches none of it. The per-row hooks
(`useSidebarThreadDraft`, `useSidebarThreadRowStatus`, …) are for a replacement
list to *consume*, not injection points into bb's own list. Inline row
expansion therefore means forking `plugins/thread-list` (~28k lines) and
re-merging it forever, so this plugin uses the two additive surfaces bb
supports instead: a row glyph and a header popover.

### Why `thread.idle` rather than polling

`bb.events.on("thread.idle", …)` delivers the thread DTO on every transition
into idle, which is the turn-completion signal a poll would be approximating.
Polling remains only as the 10-minute sweep, for activity whose event never
arrived — a server restart, a plugin reload, or a turn that ended in `error`
rather than idle.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```
