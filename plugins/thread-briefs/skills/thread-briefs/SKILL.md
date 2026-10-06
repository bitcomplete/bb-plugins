---
name: thread-briefs
description: Configure or diagnose the Thread briefs plugin — the per-thread goal/state/next-step brief, its summarizer endpoint, the sidebar glyphs, the grey ring and auto-archiving of stale done threads, the side-panel Brief tab, the Briefs board page and its sidebar count, the re-entry refresher above the composer, the manual stage and status overrides, and renaming threads to the brief's title.
---

# Thread briefs

Keeps one short, durable brief per thread — goal, current state, next step,
blocked on, constraints — generated outside the working chat so the thread's own
context stays clean. Briefs surface as a glyph on the sidebar row, in full in
the **Brief** tab of the thread's side panel (opened by the **Brief** button in
the thread header or from the panel's new-tab launcher under Actions), and all at
once on [the board](#the-board) — a **Briefs** page in the sidebar with one card
per thread in a column per stage.

The panel is where the whole brief lives, so it stays open beside the transcript;
the header button is only a way in, and holds no state of its own. Panel tabs are
per-thread and per-device (bb keeps them in the browser's local storage, keyed by
thread, and prunes idle ones), so a Brief tab open on one thread is not open on
the next — which is why the header button exists rather than expecting the
launcher every time.

## Settings

Set these with `bb plugin config thread-briefs set <key> <value>`.

| Key | Default | What it does |
| --- | --- | --- |
| `baseUrl` | `https://api.openai.com/v1` | OpenAI-compatible endpoint. Either the API root or the full `/chat/completions` URL works; trailing slashes are fine. |
| `apiKey` | _(unset, secret)_ | Bearer token for that endpoint. The plugin reports `needs-configuration` until it is set here or in the [server's environment](#deployment-wide-defaults). |
| `model` | `gpt-4o-mini` | Model used for summarizing. Any small instruction-following model works. |
| `jsonMode` | `true` | Send `response_format: {type: "json_object"}`. Turn **off** for endpoints that reject it (many local servers do). |
| `quietSeconds` | `120` | How long a thread must be quiet before it is **re**-summarized. A thread's first brief does not wait for it — see [When a brief is regenerated](#when-a-brief-is-regenerated). |
| `refresherIdleHours` | `8` | Idle hours before opening a thread shows the re-entry refresher above the composer. `0` turns it off. See [The re-entry refresher](#the-re-entry-refresher). |
| `renameThreads` | `false` | `true` renames each thread to the short name its brief chose. See [Thread titles](#thread-titles). |
| `doneStaleHours` | `24` | Idle hours after which a `done` thread's ring goes grey instead of taking its project's colour. `0` keeps every done ring coloured. See [Stale done threads](#stale-done-threads). |
| `doneArchiveHours` | `48` | Idle hours after which a `done` thread is archived. `0` turns auto-archiving off. See [Stale done threads](#stale-done-threads). |
| `sidebarGrouping` | `off` | `status` groups the sidebar into status sections instead of by project; `off` restores it. Reordering the sections by hand sticks. See [Sidebar sections](#sidebar-sections). |

The key is a secret setting, so it stays on the server and is never sent to the
frontend.

### Deployment-wide defaults

A deployment that runs one server per developer can give every server the same
summarizer through the server process's environment, so nobody has to find and
paste a key:

| Variable | Stands in for |
| --- | --- |
| `THREAD_BRIEFS_API_KEY` | `apiKey` |
| `THREAD_BRIEFS_BASE_URL` | `baseUrl` |
| `THREAD_BRIEFS_MODEL` | `model` |
| `THREAD_BRIEFS_JSON_MODE` | `jsonMode` (`true`/`false`, `1`/`0`, `on`/`off`) |

A stored setting always wins over the variable, so a developer can point their
own server elsewhere; `bb plugin config thread-briefs unset <key>` returns to
the deployment's value. The non-secret variables become the settings' defaults,
so the settings form shows what is in use. The key is never a default — a
default is part of the form — and is resolved only when a request is made.
The variables are read when the plugin loads, so a change to them takes a
server restart.

Worked example, Fireworks:

```sh
bb plugin config thread-briefs set baseUrl "https://api.fireworks.ai/inference/v1"
bb plugin config thread-briefs set model "accounts/fireworks/models/glm-5p3-flash"
bb plugin config thread-briefs set apiKey "<key>"
```

A 404 naming a doubled path (`/chat/completions/chat/completions`) meant an older
build appended the path to a `baseUrl` that already ended in it. Both spellings
are accepted now.

Clearing `baseUrl` or `model` in the settings form stores an empty string, and
a stored value wins over the deployment's — so an older build then requested
`/chat/completions` with no host and every brief failed with `Failed to parse
URL`. A blank stored value is now read as unset and falls back like `unset`
does; on a build that predates this, run `unset` instead of clearing the field.

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

Re-summarize is available in the Brief panel; it bypasses the debounce.

### The first brief does not wait

A thread with **no brief yet** is on a 5-second delay instead of `quietSeconds`,
and is summarized from `thread.active` — while its first turn is still
running — rather than waiting for that turn to end:

- The quiet period exists to stop a thread in active back-and-forth being
  re-summarized every turn. On the first brief there is nothing to protect, and
  it is the cheapest summary that thread will ever cost, because the transcript
  is at its shortest.
- It is also where the absence shows: until the first brief lands there is no row
  glyph, no sidebar section, an empty Brief panel, and bb's opening-prompt title
  still on the thread. An agentic first turn can run for ten minutes, and waiting
  for it means the thread spends all ten looking like one the plugin has never
  heard of.
- The opening prompt alone is enough for a goal, a `discovery` ring and a
  sidebar section. Every field is corrected by the summary that follows the turn.

The delay is capped at `quietSeconds`, so setting that below five seconds makes
first briefs faster rather than slower.

With `renameThreads` on, a pre-turn brief renames the thread **only if bb never
named it** — a null `title`, where the sidebar falls back to the opening prompt
clamped to 80 characters. Four words read off that prompt beat the prompt itself,
and a first turn can run for ten minutes.

Where bb did guess a name, the rename waits for the turn to end: that guess came
from the same opening prompt, so a pre-turn title is no better than what is
already there, the post-turn summary will choose better, and applying both would
rename the thread twice in a minute — each rename also dispatching a command into
the thread's environment.

Either way the name is recorded as the plugin's own, so the summary after the
turn is free to improve on it rather than reading it as a name you chose.

None of this backfills anything: a briefless thread still needs activity, and
`thread.active` *is* activity. See below.

Hidden threads (plugin workers) and deleted threads never get briefs.

**Briefs are never backfilled — activity earns a brief.** A thread gets its
first brief from a turn happening while the plugin is running — or from starting
one, since `thread.active` counts. The sweep will
only give a *briefless* thread a first brief if its last activity postdates the
current plugin load, which is activity whose `thread.idle` should have arrived
and may have been missed. A thread that has been dormant since before the plugin
started stays briefless, however old or recent, and the Brief panel says so with
a **Summarize now** button. Work on it again and it gets a brief like any other
thread.

This is deliberate: without the bound, every briefless thread would be
re-enqueued on every sweep forever — an unbounded burst of requests across the
whole thread list the first time a key is configured, and an endless retry for
any thread whose summary keeps failing.

So a thread reports `summarizing` only while work is genuinely debounced,
queued, or in flight; otherwise it reports `absent`, which the UI renders as an
offer rather than a spinner. A failed summary drops back to `absent`.

## Stage and status

`stage` is a semantic judgement from the transcript: discovery, planning,
implementation, review. It is what the sidebar row's ring draws — see
[Sidebar glyphs](#sidebar-glyphs). Pick a stage by hand in the Brief panel to
override it; the override is anchored to the thread's activity cursor and retires
itself on the next real turn. Clicking the active manual stage clears it. The
override moves the row's ring too, immediately.

Stage and status come back from one model call and are stored as answered.
The parser does not correct one against the other: "Implementation — Done" is a
model answer to fix in the prompt, not to paper over. A pinned stage is passed to
the model as fixed and returned as given.

Both overrides share that anchor rule, and "the next real turn" means a summary
whose conversation cursor has moved past where the pin was set — so
**Re-summarize** on an unchanged thread keeps your pin, and a summary after an
actual turn drops it. The anchor is never re-stamped to the new cursor; one that
advanced in step with the activity meant to expire it would never expire.

`status` has a live half and a stored half, and the live half wins:

- the thread is `active`, `starting` or `pending` → **working**, whatever the
  brief says. A run in flight is newer information than the brief, which
  describes the last turn that finished.
- otherwise, from the stored brief:
  - a manual status override in force → that status
  - the status the summarizer answered (`modelStatus` on the row)
  - a brief written before the summarizer was asked for a status has none, and
    reads the old way until its thread is next summarized: `nextStep` and
    `blockedOn` both empty → done, `blockedOn` set or `nextStepActor` `other` →
    waiting-on-other, otherwise waiting-on-me

The summarizer is asked one question: **assume you do whatever the thread asks of
you — is the task then finished, or does the thread have more to do?**

- **done** — finished. A step that is only yours ("approve PR #12", "run the
  rollout check"), an offer of extra work ("want me to add a lint rule?") and an
  optional check do not keep it open: nothing more happens in the thread either
  way. `nextStep` may still carry it, as a suggestion.
- **waiting-on-me** — your answer, decision or go-ahead starts more work in the
  thread ("the diff is ready but uncommitted — should I push?"), or the task is
  otherwise unfinished.
- **waiting-on-other** — the work cannot go on until something outside the
  thread acts, named in `blockedOn`.

One rule holds whatever the model says: a brief with a non-empty `blockedOn` is
never **done** — it reads **waiting-on-other**. A status the parser cannot read
falls back to **waiting-on-me**, because a thread wrongly left waiting costs a
glance and one wrongly called done is archived two days later.

`nextStep` and `blockedOn` are **not** fed back into the next summary as part of
the previous brief; only title, goal, currentState and constraints are. Fed
back, they outlived the turns that retired them — a step the agent had since
dropped, a rollout that had since finished — and kept finished threads out of
Done. Both are re-read from the transcript every time.

### Overriding the status by hand

Pick a status in the Brief panel to pin it, exactly as with the stage: the pin
is anchored to the thread's activity cursor, retires on the next real turn, and
clears if you click the one that is already pinned. It moves the sidebar
section as well as the row, because sections are keyed on this status.

**Why it exists.** The summarizer only sees the transcript. A go-ahead you gave
somewhere else, or a PR you merged on github.com that the thread was waiting
on, leaves no trace for any summary to read, so **Re-summarize** reads the same
open question back. The pin is the way to say it is settled — or simply that you
read the thread differently from the model.

The pin sits *in front of* the model's status rather than replacing it. It is a
separate fact the summarizer is never shown as a status and cannot undo; it is
told about it only so the refresher prose agrees.

Dragging the row into another sidebar section is **not** a substitute. Section
assignment never feeds back into a brief, so the next reconcile — on plugin
start, after any batch of briefs, or on a settings change — files the thread
straight back where its status says. Pin the status instead and the section
follows.

`nextStepActor` says who would take `nextStep` — `me`, `agent` or `other` — and
no longer feeds the status. It is optional, dropped when `nextStep` is empty or
the word is not one of the three. Its one use is the board's
`agent can continue` hint.

**Re-summarize** re-reads a thread under the current prompt. Old briefs are not
re-summarized in bulk: every idle thread that now read done would already be
past the archive threshold, and the next sweep would take them all at once.

The numbers behind the current prompt, and the harness to re-measure a change
to it, are in the plugin's `eval/` directory and README ("Measuring a prompt
change").

## The re-entry refresher

Opening a thread you have been away from shows one to three sentences of prose
in a card directly above the composer — what you were doing, how far it got,
what to do next. It is not the five fields restated: it is the thing you read
without meaning to, in the register someone would use leaning over your shoulder
as you sit back down.

```sh
bb plugin config thread-briefs set refresherIdleHours 8   # default
bb plugin config thread-briefs set refresherIdleHours 0   # off
```

### Both conditions have to hold

1. The thread has been idle for at least `refresherIdleHours`, measured from
   bb's `latestAttentionAt` — the last thing the thread did that wanted your
   attention. Not `updatedAt`, because this plugin writes thread titles and
   section assignments and both move that, and a rename by the plugin is not
   activity you were away from.
2. You have not already dismissed the refresher for *that* activity.

And three hard nevers: never on a running thread (`active`, `starting`,
`pending`), never on a thread with no brief, never when the brief has no stored
prose.

### It goes away when you engage

Sending a message retires it, through the composer's own submission signal — so
does the **×**. Either way the thread's attention cursor at the moment it was
shown is recorded, and it does not come back until the thread does something new
you have not seen. Two windows on the same thread cannot undo each other: the
record only ever moves forwards.

It is asked for once, when the banner mounts, and deliberately does **not**
subscribe to brief updates. A refresher that faded in while you were already
reading the transcript would be an interruption rather than an orientation.

### Short and full

Two variants are written by every summary and one is picked when the thread is
opened:

| Idle for | Variant | Roughly |
| --- | --- | --- |
| ≥ `refresherIdleHours` | short | one or two sentences |
| ≥ 3 × `refresherIdleHours` | full | two or three, with the detail the short one dropped |

The multiple is derived from the setting rather than configured beside it, so
tuning one number moves both boundaries and they cannot be set into a
contradiction. At the default that puts "cold" at a day, which is the span the
summarizer's own prompt is written around. If the model wrote only one of the
two, that one is used whichever was asked for — a sentence in the wrong register
beats no reorientation at all.

**No model call happens when a thread is opened.** Both variants are generated
by the ordinary summary, stored on the brief, and chosen from at open time. A
thread whose stored prose does not fit the moment shows nothing rather than
generating something.

### Overrides, and the one that is awkward

A pinned **stage** reaches the summarizer as fixed, exactly as it already does
for the five fields, so prose written under a stage pin respects it.

A pinned **status** is harder, because you can pin it long after the prose was
written — and prose that says "carry on" on a thread you have just called
blocked is the one failure this feature must not have. So:

- every brief records the status reading its prose was written for
  (`refresher.writtenForStatus`)
- opening a thread whose effective status no longer matches that shows
  **nothing**
- pinning or clearing a status queues a forced re-summary, told about the pin,
  which rewrites the prose under it

So a pin costs one summarizer call, and the refresher is blank for the few
seconds between the pin and the rewrite. If that rewrite fails, the refresher
stays blank on that thread until the next real turn — nothing wrong is ever
shown.

The pin is scoped to the two prose fields in the prompt, and the prompt says so:
the five fields still describe the work as the transcript leaves it, for the
same reason the pin sits in front of the model's status rather than editing
what it reads.

### Where it renders

`app.composer.customize({ banners })`, scoped to `thread` — bb's own prompt
stack, the strip that holds its Goal, Todo and context cards. The host owns the
position, so the card cannot cover the composer, cannot take a keystroke meant
for it, and works on a phone for free. It is not injected into the transcript
and is not a modal.

The banner is registered `chrome: "bare"` and draws its own card, deliberately.
The host's `chrome: "card"` relies on `empty:hidden` to disappear when a banner
renders nothing, and that cannot work for a plugin: bb wraps every plugin
surface in a `data-bb-plugin-root` element, so the card is never `:empty`.
Taking the host chrome would leave an empty bordered box above the composer of
every thread in bb — which, for a banner that renders nothing on nearly all of
them, is the whole feature backwards.

## Thread titles

```sh
bb plugin config thread-briefs set renameThreads true
```

Off by default. On, every summary also puts the brief's `title` — a 4–6 word
name for the work — on the thread, so the sidebar, thread header, command
palette and `bb thread list` all show it.

**Why this exists.** bb generates a thread's title exactly once, from the
opening prompt, before anyone knows what the thread became; if generation fails
or the prompt is under five words it falls back to the raw first prompt clamped
to 80 characters. Nothing in bb ever rewrites it. So a title written here is
permanent, and the brief — which reads the whole transcript every summary — has
strictly more to go on than the thing that named the thread.

**It will not clobber a name you chose.** bb records no provenance for a title,
so the plugin remembers the last title it wrote (`appliedTitle` on the brief
row) and compares:

- never written one → whatever is there is bb's guess; replace it
- thread still shows the name we wrote → ours; update it
- anything else → **you renamed it. Renaming that thread stops permanently.**

The stop needs no flag: the skipped rename leaves `appliedTitle` pointing at the
old name, so the comparison keeps failing on every later summary. Rename a
thread back to exactly the name the plugin last wrote and it resumes.

The thread is re-read immediately before the write, so a rename made *during* a
summarizer call (up to 60s) is not overwritten by a name chosen before it.

Other things worth knowing:

- The previous title is fed back to the summarizer, so a settled thread's name
  stays put instead of wobbling between synonyms. A write only happens when the
  name actually changes — which matters because bb's title PATCH also dispatches
  a rename command to the thread's environment.
- Names are clamped to 48 characters at a word boundary, matching bb's own cap;
  wrapping quotes and trailing punctuation are stripped. A model answer of
  `N/A`, `none` or similar is treated as "no name" and the thread is left alone.
- The name is stored on the brief whether or not renaming is on, so turning the
  setting on later has one ready for every thread with a brief. It is applied at
  the next summary, not retroactively.
- **Turning it off does not undo anything.** bb's original title is not kept
  anywhere; the last name the plugin wrote stays. Rename by hand to change it.
- Branch names are derived at thread creation and are unaffected.

## Sidebar glyphs

The row glyph is a **stage ring** — a circle in four quarters, filled up to the
stage the thread has reached:

| What the row shows | Means |
| --- | --- |
| one quarter (fill ends at 3 o'clock) | discovery |
| half (ends at 6) | planning |
| three quarters (ends at 9) | implementation |
| closed ring, hollow | review |
| closed ring, centre filled | status `done`, any stage |
| the ring's **colour** | which project the thread is in |

Names are registered by the app through `app.experimental_icons.register` as
`thread-briefs/stage-<stage>` and `thread-briefs/done`, each also in a `-c<n>`
variant per palette slot, plus `thread-briefs/done-stale`; a row status takes an
icon *name*, not a component, so the artwork has to go in the registry first.
They are mapped off `BRIEF_STAGES` and `PROJECT_RING_HUES`, so adding a stage or
a hue adds its rings. `done-stale` has no `-c<n>` variants — see
[Stale done threads](#stale-done-threads).

### The project colour

`sidebarGrouping status` replaces the sidebar's project grouping, so nothing on
a row says which project a thread is in. The ring's colour says it: a hue from
`PROJECT_RING_HUES`, picked by `projectColorIndex` — an FNV-1a hash of the
project id, so the colour is stable across windows, machines and reloads with
nothing stored, and adding or removing a project never reshuffles the others.

Every ring takes a colour, including when the sidebar holds a single project.
Drawing it only on a list spanning two or more would mean the channel had to be
interpreted before it could be read, against a rule nothing in the sidebar shows
you — and "only one project" is a fact a filter or a newly added project can
change without any thread having changed.

`done` therefore has **no green**: the success tone is gone from the row
entirely, rather than surviving on the rows that reach the decoration without a
project. `done` keeps the two marks that never needed the colour channel — the
filled centre, and its section heading. A thread the host reports with no
project id keeps the plain `currentColor` ring and is skipped rather than
throwing, so one bad entry cannot cost the other rows their glyphs.

Each hue renders through `light-dark()` at two lightnesses: no single lightness
clears 3:1 on the light sidebar and still reads on the dark one. bb sets
`color-scheme` on both themes, so the browser picks and a theme switch needs no
re-render.

A hue cannot name itself, so the hover label carries the project name:
`Implementation — Waiting on you (bb-dylan)`. A thread whose project has not
loaded into the sidebar yet still gets its colour — that comes from the id — and
picks up the name suffix when the project arrives.

Threads with **no brief** get no row status at all, so they get no colour
either. They sit in bb's unassigned Threads group.

### Stale done threads

A `done` thread with no activity for `doneStaleHours` draws
`thread-briefs/done-stale` — the same closed ring in grey — and its hover label
gains the reason: `Review — Done · idle 2 days, archiving soon`. At
`doneArchiveHours` it is archived.

```sh
bb plugin config thread-briefs set doneStaleHours 24    # 0 keeps every done ring coloured
bb plugin config thread-briefs set doneArchiveHours 48  # 0 never auto-archives
```

A done thread may still carry a step that is yours — approving a PR, running a
check — and is archived on the same clock. That is deliberate: the step sits on
the card in the Done section for two days, the hover label warns for the second,
and an archived thread un-archived by hand is never auto-archived again. If you
want longer, raise `doneArchiveHours`.

The grey **replaces** the project hue; there is no `-c<n>` variant of it. The row
has one channel, colour on it means a live project, and a thread about to leave
the sidebar has no use for the mark saying whose it is. The shape is unchanged,
so the row still reads as done and the grey only adds "and nobody came back".

Idleness is `latestAttentionAt`, not `updatedAt` — this plugin writes thread
titles and section assignments, and both move `updatedAt`, so filing a done
thread into ✅ Done would otherwise reset the clock its own section's threads are
timed on. Not `lastSummarizedAt` either: **Re-summarize** moves that, so reading
a finished thread would postpone its archiving.

Both halves go through one predicate, `isStaleDone` in `shared.ts`, so a grey
ring is exactly a thread the sweep will take one threshold later — the grey is
the warning, not a second opinion. The ring is computed on the client from the
cursor already on the sidebar row, re-tested every 60s, so a window left open
overnight greys without a reload; the thresholds ride along on
`listRowSignals`, which still does no per-thread lookups.

**The archive sweep** (`archive-done`, `17 * * * *`) runs on its own schedule
rather than inside `brief-sweep`, which returns early with no API key —
archiving has nothing to do with whether a summarizer is configured. Every other
rule is a reason *not* to archive:

| Left alone | Why |
| --- | --- |
| Pinned threads | A pin is a deliberate "keep this in front of me" and outranks anything inferred. It still greys. |
| Threads with no brief | Briefs are never backfilled, so a briefless thread is one this plugin has never read. |
| Threads it archived before | `autoArchivedAt` on the brief row. Un-archiving by hand is final, not an argument to re-win every hour. |
| Busy, hidden, deleted, already archived | Nothing to do, or not ours. |

`autoArchivedAt` is deliberately **not** carried across a re-summary:
`summarizeThread` builds a fresh row, and a summary only happens on real new
activity — so the exemption lasts exactly as long as the thread stays untouched,
and working in it again puts it back in the normal cycle.

To see what the sweep is doing: `bb plugin logs thread-briefs` shows
`auto-archived N done thread(s)` per pass, and `could not archive <id>` for one
it could not take (the next pass retries).

**Why stage and not status.** With `sidebarGrouping status` on, the section
header already says the status, so a status glyph spends the row's one slot
repeating its own heading. Stage is orthogonal, ordinal, and answers the triage
question the grouping cannot: which of the threads waiting on you is one turn
from done. `done` stays off the ring as a status, not a fifth stage — four
segments is where you can read the fill's endpoint as a clock position instead of
counting marks.

**What this costs.** `waiting-on-me` and `waiting-on-other` draw the **same**
ring. Grouping tells them apart; with grouping off, only the hover label does
(`Implementation — Blocked`). If that bites, the cheap fix is a centre mark on
the blocked ring rather than a different glyph family.

`working` still draws **nothing**, so the live override reads as a
**suppression**: a running thread shows no brief glyph, and its stored ring comes
back the moment it goes idle. Three reasons, and the first is not the plugin's
choice:

- bb hides a plugin row status outright when its own indicator is `runtime`,
  `unread-error` or `waiting-for-input`, so a decoration on a plain running
  thread is ignored anyway.
- It is *not* hidden for `plan-mode`, `goal`, `workflow` or `background-agent`,
  where a ring would displace a shimmering live glyph that says something a
  stored brief cannot.
- bb paints the status in place of the unsent-draft pencil, so any decorated row
  loses its pencil.

The live half is computed in the client from `experimental_useSidebarThreads()`,
which is why no row needs a server round trip to stay current, and why
`listRowSignals` does no per-thread lookups.

One consequence worth knowing: the Brief panel shows the **stored** status, so
a running thread whose brief says "Waiting on you" will say that in the panel
while its row shows no glyph. The row is live; the panel is the brief.

The panel is also where the ring is learned — the stage control draws each option
beside its own ring, and the status line at the top draws the ring that thread's
row is currently showing.

## The board

A **Briefs** item in the sidebar (bb's own nav-panel list, beside Plugins and
Skills) opens a page with one card per thread in a column per stage:

```
┌─┬───────────┬──────────┬────────────────┬────────┬─┐
│N│ Discovery │ Planning │ Implementation │ Review │D│
│o│           │          │                │        │o│
│ │           │          │                │        │n│
│s│           │          │                │        │e│
└─┴───────────┴──────────┴────────────────┴────────┴─┘
```

Columns are **stage**; the filters are **status** and **project**. That split is
the design: status is the question you arrive with, stage is the one you arrive
unable to answer, so filtering on the first and laying out the second answers both
at once.

Two columns are not stages, and both collapse to a rail so the four stages hold
the width:

- **Done** is a status. It gets the terminal column anyway, because otherwise
  Review holds both "needs my review" and "finished, archiving tomorrow". A done
  card still draws the closed ring, so its stage stays readable.
- **No stage** holds every thread with no stored brief — never summarized, or a
  first summary still in flight. Briefs are never backfilled, so this bucket is
  real and permanent for old threads; each card offers **Summarize**. Same role as
  bb's **Threads** group under [status grouping](#sidebar-sections). The label
  names the axis; the card face names the cause.

### Collapsed columns

| Column | Collapsed |
| --- | --- |
| **Done** | always, until you open it — the board then remembers it open |
| **No stage** | while it is empty — it opens itself as soon as it holds a thread |
| any stage | never |
| the only column on the board | never (filtering to `status:done` leaves Done alone, and one closed strip is not a board) |

A rail keeps its label, its count and its drop target, so it can never read as
empty and dropping a card on Done still finishes it by hand; the rail widens while
a card is in the air. Clicking a rail expands it and writes `expand:<column>` into
the remembered view, so the board reopens with it open. A rail with a count of
zero is not a button — there is nothing behind it to show.

A column a filter can only leave empty is **hidden**, not drawn empty. Filtering
to Done leaves one column; filtering to any other status drops Done *and* No stage
— a thread with no brief has no status to match. A status filter that merely
*includes* `done` does not force Done open: the filter and the rails are separate
readings of the board, and only the rails say which rails are open.

### The card

`nextStep` is the body, not `goal`: the board's question is which thread to pick
up. Goal, current state and constraints are behind the chevron, which fetches them
with `getBrief` for that one card. Also on the face: the stage ring in the
project's colour (the same glyph as the sidebar row, including the grey one for a
cold done thread), a status badge, `blockedOn`, the project, and the idle age.

`agent can continue` appears when `nextStepActor` is `agent` and the status is
`waiting-on-me`. That status covers both a thread waiting on your answer and
one the agent could carry on by itself, so this is the only place the difference
shows.

Order inside a column: pinned threads, then `waiting-on-me` → Blocked → Working →
Done, then most recently active. Working ranks low deliberately — the agent has
it. Past 50 cards a column offers **Show all**.

### Dragging

A drag writes the same manual pins the Brief panel does, and they retire the same
way — anchored to the thread's activity cursor, gone on the next real turn, which
is what the `pinned` marker on the card is warning about.

| Drag | Writes |
| --- | --- |
| to another stage column | `setStageOverride(<stage>)` |
| to the stage the summarizer already chose | `setStageOverride(null)` — clears the pin |
| to **Done** | `setStatusOverride("done")` |
| out of **Done** | `setStatusOverride("waiting-on-me")`, then the stage if it also changed |
| to or from **No stage** | nothing |

Dragging out of Done *pins* rather than clears because a done reading can come
from the model as well as a pin; clearing would hand the card back to a model
reading that still says done and it would snap straight back.

Drag-and-drop does not work on touch, so the **expanded card carries the panel's
own stage and status controls**. On a compact viewport the columns stack into one
scrolling list with their headers as section headings.

### The remembered view

The filters *and* which rails are open are one view, kept in component state and
mirrored to `localStorage` (keyed by plugin id, under `<pluginId>:board-filters`)
as a single line:

```
                                  # everything, Done collapsed
status:waiting-on-me              # what needs you
project:prj_a/status:done         # one project, finished
expand:done                       # everything, Done open
```

It is written whenever you change a filter or a rail, and read once when the board
mounts, so reopening the page lands where you left it. Unrecognised keys and
values are ignored rather than fatal, which is what makes `expand:` additive — a
line stored before it existed still parses, and one stored after still parses in a
build without it. Changing a filter leaves the rails as they were.

**Not the panel's `subPath`.** That was the first home for this and it loses the
view: `useBbNavigate().toPluginPanel` percent-encodes every path segment, and
react-router 7 returns params raw (it undoes `%2F` and nothing else), so
`status:done` comes back as `status%3Adone` and parses as no filter at all. The
symptom is a board that renders correctly and responds to nothing — chips that
never light, rails that never open. If a future bb decodes its params, a board
view could move back into the URL and become linkable again.

The project chips only list projects that have a thread on the board, and appear
only when there is more than one.

### The count on the sidebar row

The number beside **Briefs** is threads `waiting-on-me`, with running threads
excluded (they are `working`). It costs no request: the overlay that draws the row
glyphs has already folded the briefs against the live thread list, and the badge
reads that store. Nothing is drawn at zero.

### Cost

One `listBriefCards` per window per `briefs-changed` — one kv scan, no per-thread
lookups, and the four prose fields the card never shows stay off the wire.
Everything live comes from `experimental_useSidebarThreads`, which reads bb's own
cache. The board shows **active** threads only; archived ones are not requested.

## Sidebar sections

`bb plugin config thread-briefs set sidebarGrouping status` replaces the
sidebar's project grouping with three sections, top to bottom, and then bb's own
**Threads** group:

| Section | Holds |
| --- | --- |
| 🙋 Waiting on you | stored status `waiting-on-me` |
| ⏸️ Blocked | stored status `waiting-on-other` |
| ✅ Done | stored status `done` |
| Threads (bb's own) | every thread with **no brief** |

Threads last is the design, not an oversight. A thread with no brief is left
*unassigned* rather than filed anywhere, so that group is exactly the briefless
set — including a thread created since the last sync, which needs no sync to
appear. Hiding it would lose threads, so don't add `threads` to `hiddenGroups`.

That order is only the **default**. Reorder the sections in the sidebar — drag
them, or write `manualSectionOrder` yourself — and the sync leaves your order
alone from then on: an order holding the same entries is treated as correct
however it is arranged, whichever way up `threads` sits. The default order only
decides where a *new* entry lands, inserted after the last entry the default
puts above it rather than appended, so a section added later shows up beside its
siblings. An entry the sync does not own — a retired section, a duplicate — is
dropped the next time it has to write the order at all.

There is **no section for running threads**. `working` is live state and never
reaches a stored brief, so a section keyed on it could not have members; a
running thread sits where its last brief puts it and keeps bb's own running
indicator. Grouping on live state would mean the server reacting per thread,
which is the cost the row glyph design already avoids.

What the sync owns, and hands back on `off`:

- the three sections — deleted on `off`, which clears their assignments
- `organizationMode` → `chronological`
- `chronologicalSort` → `updated` (newest first inside each section)
- `manualSectionOrder` → pinned, the three sections, then `threads`, but only
  while the stored order is missing an entry; a reordering of the same entries is
  yours and is never overwritten

Prior values are recorded before the first write and restored on `off`; a
preference bb had never been given is reset rather than guessed at, because
`thread-list` owns its own defaults. A thread **you** filed in a section of your
own is left alone while it has no brief, but once it has one the grouping takes it
over, and `off` cannot put a hand-made placement back.

Reconciles run on plugin start, after any batch of briefs is written (debounced,
so a burst is one pass), and whenever the setting changes. It is idempotent: a
thread already in the right section is not touched, and a settled sidebar costs
no preference writes.

## Diagnosing

- `bb plugin list` — service and schedule status, including the sweep's
  `last_status` / `last_error`.
- `bb plugin logs thread-briefs -n 50` — per-thread summarizer failures are
  logged as warnings and never crash the queue. Section syncs log what they
  moved, and a failed sync logs `sidebar grouping failed` rather than retrying.
- Sections exist but the sidebar still groups by project: check
  `bb thread-list prefs get organizationMode`. Something changed it back after
  the sync; the next reconcile will set it again.
- A section order that reverts: expected only up to the first pass after a
  section is added or retired, which is the one pass that rewrites the order. A
  drag that reverts on *every* brief write is a bug — the sync compares entry
  sets, not arrangements.
- No glyphs at all, but the Brief panel works: the bb client predates
  `experimental_setThreadRowStatus`, which the content script feature-detects.
- A lightning bolt where a ring should be: that is bb's `Zap` fallback for an
  unknown icon name, so the ring registrations did not take. The client predates
  `app.experimental_icons`, or the app bundle is stale — rebuild with
  `bb plugin build` and reload.
- Briefs stuck on "Summarizing…": check `apiKey` is set, or
  `THREAD_BRIEFS_API_KEY` in the server's environment, and
  `bb plugin logs thread-briefs` for HTTP errors from `baseUrl`.
- Every brief failing with `Failed to parse URL from /chat/completions`: the
  effective `baseUrl` is empty. `bb plugin config thread-briefs` shows
  `baseUrl = ""` — a cleared field stored as a blank, which beat the
  deployment's `THREAD_BRIEFS_BASE_URL`. `bb plugin config thread-briefs unset
  baseUrl` (and `unset model` if it is blank too) restores the deployment's
  value; current builds treat the blank as unset on their own.
- A brief that describes work already finished: read the **Summarized …** line
  under the status. Briefs are only rewritten after `quietSeconds` of quiet, so
  one that predates the last few turns is expected rather than broken;
  **Re-summarize** forces it. Note this does not apply to a *first* brief, which
  does not wait.
- A brand-new thread whose brief reads as though the work has not started: also
  expected. That is the pre-turn brief, written from the opening prompt while the
  first turn runs, and the summary after that turn replaces it.
- A brand-new thread still showing bb's title: expected only while bb gave it
  one. A thread bb left with a null `title` — the row showing its raw opening
  prompt — is named by the pre-turn brief instead of waiting. If such a row keeps
  its prompt, the rename failed: check `bb plugin logs thread-briefs` for
  `could not rename`.
- A finished thread stuck on **Waiting on you**: first check the brief is new —
  a brief written before the summarizer answered status reads the old way, and
  **Re-summarize** rewrites it. If it is new and the thread waits on a go-ahead
  you gave elsewhere, pin the status to **Done** in the Brief panel — see
  [Overriding the status by hand](#overriding-the-status-by-hand).
- A **Done** thread that still shows a next step: expected. Done means nothing
  more happens in the thread once you do what it asked; the step left on the
  card is yours, and the thread is archived on the usual clock.
- A thread that will not stay in the section you drag it to: sections are keyed
  on status and nothing feeds an assignment back into a brief, so the next
  reconcile undoes the move. Pin the status instead.
- No re-entry refresher on a thread you have not touched in days: check
  `refresherIdleHours` is not `0`, that the thread has a brief at all, and that
  you have not already dismissed it for that activity — it shows once per new
  activity, not once per open. A thread whose brief predates this feature has no
  stored prose; **Re-summarize** writes some.
- The refresher stopped appearing right after you pinned a status: expected for
  a few seconds. The prose is being rewritten for the pin, and nothing is shown
  in the meantime. If it never comes back, the re-summary failed —
  `bb plugin logs thread-briefs` will have the HTTP error, and the next real
  turn will try again.
- The refresher shows prose that reads stale: it is written by the summary, so
  it is exactly as fresh as the **Summarized …** line in the Brief panel.
  **Re-summarize** rewrites both.
- A thread missing from the board entirely: the board is driven by the sidebar's
  thread list, so an archived or hidden thread has no card even if it has a brief.
  Check whether the [archive sweep](#stale-done-threads) took it.
- The board's **No stage** column is huge on a fresh install: expected. Briefs are
  never backfilled; the column empties as threads are worked, or card by card with
  **Summarize**, and collapses to a rail once it is empty.
- A card that moved back to where it was a turn later: that is the pin retiring,
  not a failed write. Pins are anchored to the thread's activity cursor by design;
  the `pinned` marker on the card says one is in force.
- A card that will not stay out of **Done**: pin the status to something else from
  the expanded card. Dragging already does this, but a re-summary after the next
  turn may read `done` again if the transcript still says the task is finished.
- Drag does nothing on a phone or tablet: expected — it is an HTML5 pointer drag.
  Use the stage and status controls on the expanded card.
- No **Briefs** item in the sidebar: it is a nav panel, so it can be hidden or
  reordered by the user in bb's own sidebar customize editor. Check there before
  suspecting the plugin.
- The header **Brief** button does nothing: it opens a tab in the thread's side
  panel, which only the main thread view has. A `ThreadChat` embedded elsewhere
  has no panel to open, and the host logs the declined open.
- "No brief for this thread yet" on an older thread is expected, not a fault —
  briefs are never backfilled. Work the thread, or use **Summarize now**.
- A thread that stopped picking up new titles was renamed by hand at some point;
  that is the designed stop, and it is permanent. To restart it, rename the
  thread to exactly the last name the plugin gave it.
- Renames logged as `could not rename <id>` leave the brief intact and retry on
  the next summary.
