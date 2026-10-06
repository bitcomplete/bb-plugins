# Thread briefs

Threads in the bb sidebar are opaque — a truncated title, and re-entering one
means re-reading the transcript to remember what it was for. This plugin gives
every thread a short, durable **brief**, generated outside the working chat:

- **goal** — what the thread is actually trying to achieve
- **currentState** — what exists now, including half-done work
- **nextStep** — the most useful next action, if there is one. Descriptive only:
  a finished thread may still carry a suggestion here
- **nextStepActor** — who would take it: `me`, `agent`, or `other`
- **blockedOn** — the party or artifact outside the thread it is waiting on, when
  someone could go chase it
- **constraints** — facts learned in the thread that would break a naive re-plan
- **title** — a 4–6 word name for the work, which can optionally replace bb's
  own thread title

Plus a **stage** (discovery / planning / implementation / review) and a
**status** (working / waiting-on-me / waiting-on-other / done). `working` comes
from bb's live thread state; the other three statuses and the stage are asked of
the model directly.

The status question is one sentence: *assume you do whatever the thread asks of
you — is the task then finished, or does the thread have more to do?* Yes is
`done`, even when a step is left that only you can take ("approve PR #12", "run
the rollout check"), because nothing more will happen in the thread either way.
No, because your answer or go-ahead starts more work here, is `waiting-on-me`.
No, because something outside the thread has to act first, is
`waiting-on-other`, and names that thing in `blockedOn`.

### Why status is asked for, not derived

Status used to be derived: an empty `nextStep` and an empty `blockedOn` meant
done. That made Done a side effect of the model leaving two strings blank, while
the same prompt asked for "the single most concrete next action" — and a model
asked for one finds one. Four rules accumulated in the prompt pulling the
boundary one way and the other, and on the bb-dylan server 11 of 21 Done threads
were Done only because someone had pinned them by hand. Reading each of those 11
against its transcript gave three causes:

- an offer or optional check recorded as the step ("want me to file an issue?",
  "if you want the hash confirmed, run…");
- a `nextStep` or `blockedOn` carried over from the previous brief, which was fed
  back as the starting point and outlived the turns that retired it;
- a step that was the user's, done outside the thread.

So the model now answers the status itself, with one definition and one example
per value; `nextStep` no longer decides anything; and the previous brief fed back
into the next summary carries only the fields that should hold still — title,
goal, currentState, constraints. `nextStep` and `blockedOn` are re-read from the
transcript every time.

The parser applies one rule on top, which holds whatever the model thinks: a
brief that names a `blockedOn` is never `done`. An unreadable status falls back
to `waiting-on-me`, the reading whose mistake is cheap. There are no other
field-against-field corrections — stage and status are stored as answered.

A brief written before this change has no stored status and keeps the old
derivation until its thread is next summarized. They are deliberately not
re-summarized in bulk: every old idle thread that now read done would be past
the archive threshold already, and the next sweep would take them all at once.

### Measuring a prompt change

`eval/` holds the harness that produced the numbers behind this. `export.ts`
freezes threads from a running server into fixtures (outline, last message, the
stored brief); `run.ts` runs a checkout's prompt over them against the live model
and reports agreement with hand-given labels, false Dones and missed Dones, with
and without the previous brief fed back. Point `--src` at a `git worktree` of
`main` to score the old prompt against the same set. Fixtures are real
transcripts and bb-plugins is public, so they live outside the repository.

Either can be pinned by hand in the Brief panel, anchored to the thread's
activity cursor so the pin retires on the next real turn. The status pin is what
closes a thread whose next step was carried out somewhere the transcript cannot
see — a go-ahead you gave in another thread, a PR you merged on github.com —
leaves nothing for a summary to read.

## Install

```sh
bb plugin install git:https://github.com/bitcomplete/bb-plugins.git@main --plugin thread-briefs
bb plugin config thread-briefs set apiKey <key>
```

The summarizer talks to any OpenAI-compatible `/chat/completions` endpoint. See
[`skills/thread-briefs/SKILL.md`](skills/thread-briefs/SKILL.md) for every
setting, the regeneration triggers, and how to diagnose it.

A deployment running a server per developer can hand them all one summarizer
instead: set `THREAD_BRIEFS_API_KEY`, and optionally `THREAD_BRIEFS_BASE_URL`,
`THREAD_BRIEFS_MODEL` and `THREAD_BRIEFS_JSON_MODE`, in the server's environment.
A developer's own setting still wins; `bb plugin config thread-briefs unset
<key>` goes back to the deployment's, and a `baseUrl` or `model` stored blank
is read as unset too.

## Where briefs show up

**Sidebar row** — a **ring** showing the stage: one of four quarters filled per
stage reached, so `discovery` is a quarter, `implementation` is three quarters,
`review` closes the ring, and a `done` thread gets the closed ring with its
centre filled in.

The glyph draws the stage rather than the status because status is what the
sidebar's own [status grouping](#sidebar-sections) already puts in the section
header — a status glyph spends the row's one slot repeating its own heading.
Stage is orthogonal to it, and is the thing that says which of a dozen threads
waiting on you is one turn from finished. It is also ordinal, which a ring can
show and a set of unrelated glyphs cannot: four rings are read at a glance
without reading any of them, and the fill's endpoint lands on a clock position
rather than a count of marks. `done` is a status, not a fifth stage — keeping it
off the ring is what holds the ring at four readable segments.

Two consequences. `waiting-on-me` and `waiting-on-other` draw the **same** ring,
told apart by the section header or the hover label (`Implementation —
Blocked`). And a thread whose agent is running or queued keeps bb's own
indicator: bb hides a plugin row status outright while its own is `runtime`, and
where it does not — plan mode, a goal, a workflow — a ring would displace a live
glyph that says more than a stored brief can. bb also paints the status in place
of its unsent-draft pencil, so decorating a row is never free. The live status is
folded in per row on the client, off the sidebar view it already holds, so
`listRowSignals` needs no per-thread lookups.

The same rings label the stage control in the Brief panel, which is where the
vocabulary is learned: four rings in a row, each next to its name.

**A done thread that goes cold loses its colour.** A day after it finished, with
no activity since, the closed ring turns **grey** and its hover label says how
long and what is coming (`Review — Done · idle 2 days, archiving soon`). A day
after that it is [archived](#auto-archiving-finished-threads).

```sh
bb plugin config thread-briefs set doneStaleHours 24   # 0 keeps every done ring coloured
```

Grey *replaces* the project hue rather than joining it, because the row has one
channel: colour on this row means a live project, and a thread on its way out of
the sidebar has no use for the mark that says whose it is. The shape does not
change, so the row still reads as done at a glance and the grey only adds "and
nobody came back".

Staleness is measured from bb's own `latestAttentionAt`, and the whole rule is
one predicate (`isStaleDone` in `shared.ts`) shared by the ring and the sweep —
so a ring that has gone grey is exactly a thread the sweep will take, one
threshold later. That is the point of the grey: it is the warning, not a second
opinion. It is computed on the client from the cursor already on the sidebar row,
on a one-minute tick, so a window left open overnight greys without a reload and
`listRowSignals` still needs no per-thread lookups.

**The thread title itself** — optionally, the brief's name replaces it:

```sh
bb plugin config thread-briefs set renameThreads true
```

bb names a thread once, from the opening prompt, before anyone knows what it
became — and nothing in bb ever rewrites it. The brief re-reads the whole
transcript every summary, so it has strictly more to go on. With this on the
name lands everywhere bb shows a title: sidebar, header, command palette,
`bb thread list`.

Where bb ended up with no title at all, the row falls back to its raw opening
prompt, and the first brief names the thread without waiting for the first turn
to finish. A thread bb *did* name keeps that name until the turn ends and the
better-informed summary arrives.

It will not clobber a name you chose. The plugin remembers the title it last
wrote, and finding anything else on the thread means you renamed it — so that
thread is never renamed again. Nothing is stored to record the stop: the skipped
rename leaves the remembered name pointing at the old one, so the comparison
keeps failing. The thread is also re-read immediately before the write, so a
rename made during a summarizer call is not overwritten by a name chosen before
it. Turning the setting off undoes nothing — bb's original title is not kept.

**A page of its own** — a **Briefs** item in the sidebar opens [the
board](#the-board): every thread as a card, in a column per stage, filtered by
status and project, with a count of what is waiting on you on the sidebar row.

**Sidebar sections** — optionally, the sidebar groups by status instead of by
project:

```sh
bb plugin config thread-briefs set sidebarGrouping status   # on
bb plugin config thread-briefs set sidebarGrouping off      # off again
```

**🙋 Waiting on you**, **⏸️ Blocked**, **✅ Done**, then bb's own **Threads**
group, newest first inside each. Threads is last and holds every thread with no
brief — including ones created since the last sync — which is why it must not be
hidden: it is the "the summarizer hasn't reached this yet" bucket as much as a
catch-all.

The emoji *is* the header glyph. bb draws a section header as plain text and has
no icon on a section, so the only way to tell the three apart at a glance is the
name itself. A section is also keyed on its name, so changing one of these names
is a **rename** of the existing section rather than a new one beside it — that is
what `formerNames` in `sections.ts` is for, and it is why renaming a section by
hand makes the next sync build its own alongside yours.

Two things to know. There is **no section for running threads**: `working` is
live state and never reaches a stored brief, so a thread whose agent is running
sits in the section its last brief implies and keeps bb's own running indicator —
the same live-vs-stored split as the panel. And a thread you filed in a section
of your own is left alone until it has a brief, but once it does the grouping
takes it over; turning grouping off deletes the three sections and restores the
sidebar preferences it changed, but cannot put a hand-made placement back.

**The side panel** — a **Brief** tab holding the full five fields (empty ones
are skipped), the status, when it was last summarized, status and stage
controls for the manual overrides, and Re-summarize. The **Brief** button in the thread
header opens it; so does the panel's own new-tab launcher, under Actions. It
works the same on mobile and desktop — on a compact viewport the host reveals
the panel drawer as part of the open — and nothing depends on hover.

A panel rather than a popover because reading the whole brief is a deliberate
shift out of chatting and into orienting: it wants to stay open beside the
transcript while you scroll it, and a popover closes on the first click outside
itself. The button stays because panel tabs are per-thread and per-device — a
Brief tab open on one thread is not open on the next — so without a fixed
control in the header, seeing a brief would mean walking the new-tab launcher on
every thread, which is friction landing on exactly the moment this is for.

**Above the composer** — a **re-entry refresher**: one to three sentences of
prose, in a card in the prompt stack, on a thread you have been away from.

```sh
bb plugin config thread-briefs set refresherIdleHours 8   # 0 turns it off
```

The five fields are a reference, and a reference is something you consult. This
is the thing you read without meaning to: what you were doing, how far it got,
what to do next, in the register someone would use leaning over your shoulder as
you sit back down. The two variants — a line for a thread you left this morning,
a paragraph for one you left last week — are both written at summarize time and
chosen when the thread is opened, because how much you have forgotten is a fact
about the gap, not about the thread. **No model call happens when a thread is
opened.** If the stored prose does not fit the moment, nothing is shown.

It appears only when reorienting is actually likely: the thread has been idle
past the threshold **and** you have not already dismissed that particular
activity. It never appears on a running thread, never on a thread with no brief,
and never twice for the same activity — sending a message or dismissing it
records the thread's attention cursor, and only new activity you have not seen
brings it back.

A composer banner rather than a floating overlay, because bb owns the position:
the card sits in the same prompt stack as bb's own Goal and Todo cards, which
means it structurally cannot cover the composer, cannot take a keystroke meant
for it, and follows the composer to the bottom of a phone screen for nothing.
Positioning a fixed card ourselves would put it over the transcript as asked, at
the cost of measuring a private DOM attribute and a list of viewports where it
lands on something. A surface that cannot get in the way beats one that has to
keep checking whether it has.

The prose respects both manual overrides. A pinned stage reaches the summarizer
as fixed, the same way it already does for the fields. A pinned **status** is
harder, because it can be set long after the prose was written — so each brief
records the status reading its prose was written for, pinning a status queues
the re-summary that rewrites it under the pin, and until that lands the
refresher shows nothing rather than telling you to carry on with something you
have just called blocked.

Briefs are **never backfilled** — activity earns a brief. A thread that has been
dormant since before the plugin started stays briefless, and the panel says so
with **Summarize now** rather than showing a spinner that would never resolve.
Work on it again and it gets a brief like any other thread. The alternative —
summarizing every existing thread — is an unbounded burst the first time a key is
configured.

What *does* count as activity is deliberately early: a thread that starts
running has earned a brief, before the turn it is running has finished. The
quiet period is there to stop a busy thread being re-summarized every turn, and
a thread with no brief has nothing to protect — only an empty panel, a missing
ring and no section, for as long as its first turn takes.

## The board

A **Briefs** page in the sidebar, beside Plugins and Skills: every thread as a
card, in a column per stage, with a count of what is waiting on you on the
sidebar row itself.

The sidebar row has one slot and this plugin spends it on the ring, so everything
else a brief knows has nowhere to go there; the Brief panel has room but shows one
thread at a time, which is the wrong shape for "which of these should I pick up".

**The columns are stages. The filters are statuses.** Status is the question you
arrive with — *what needs me?* — so it filters. Stage is the question you arrive
unable to answer — *of the eleven threads waiting on me, which is one turn from
done and which has not started?* — so it lays the board out. A status filter and
a stage layout answer both in one glance; two stacked statuses would answer
neither.

```
┌─┬───────────┬──────────┬────────────────┬────────┬─┐
│N│ Discovery │ Planning │ Implementation │ Review │D│
│o│           │          │                │        │o│
│ │           │          │                │        │n│
│s│           │          │                │        │e│
└─┴───────────┴──────────┴────────────────┴────────┴─┘
```

Six columns, in flow order — and the four stages hold the width, because the two
columns that are not stages collapse to a rail. Each of those two is a deliberate
exception:

- **Done** is a *status*. It gets a terminal column anyway because the whole
  affordance of a kanban is work flowing left into a bucket you stop looking at,
  and without one the Review column mixes "needs my review" with "finished,
  archiving tomorrow" — exactly the confusion the board exists to remove. The
  cost is that column position stops meaning stage for that one column, and it is
  paid back on the card: a done card still draws the closed ring, so its stage is
  still legible.
- **No stage** holds every thread with no stored brief. Briefs are never
  backfilled, so on any real install that is a real set — and a board that quietly
  omitted them could not be read as "everything I have open", because a missing
  thread would be indistinguishable from a finished one. Each card offers
  **Summarize**. It is the same job bb's own catch-all **Threads** group does for
  the [status sections](#sidebar-sections). Named for the axis rather than the
  cause: every card resolves a stage, so this column is both the threads never
  summarized *and* the ones whose first summary is still in flight, and "no stage"
  is the one label true of both. The card face still says which.

**The bookends collapse; the stages spread.** Six equal columns meant the four
that answer "what should I pick up" were the ones pushed off the side of the
viewport, for two that do not: **No stage** is empty whenever the summarizer has
caught up, and **Done** fills with cards whose whole point is that you are
finished with them. So both give their width up and the stages take it. Three
rules:

- **Done starts collapsed** until you open it. Expanding is one click and it
  sticks, so "show me what I finished" is a board you keep rather than a click
  you repeat.
- **No stage collapses only while it is empty** — which is most of the time, and
  is exactly when it is worth nothing. When it does hold threads, the Summarize
  button on those cards is the point, so it opens itself.
- **The only column on the board never collapses.** Filtering to Done leaves Done
  alone, and a board consisting of one closed strip is not a board.

A collapsed column is a rail, not an absence: it keeps its label and its count,
so it can never be misread as empty, and it stays a drop target — dropping a card
on Done is how you finish one by hand, and the rail widens while a card is in the
air rather than asking you to aim at 2.5rem.

A column that a filter can only ever leave empty is hidden rather than drawn
empty, since an empty bucket reads as "nothing here" when the filter is what
emptied it. So filtering to **Done** leaves one column; filtering to anything else
drops Done and No stage — a thread with no brief has no status, and asking for one
is asking a question only a brief can answer.

**The card** leads with `nextStep`, not `goal`. Goal is what you need when you
have forgotten a thread; nextStep is what you need when choosing between threads,
which is what this page is for — goal, current state and constraints are one
chevron away, where they answer the other question. Around it: the stage ring in
the project's colour, a status badge, `blockedOn` when set, the project, and how
long the thread has sat. A next step the *agent* could take by itself is marked
`agent can continue`, because `waiting-on-me` covers both that and work only you
can do, and on a board the difference is worth a word.

Cards are ordered pins first, then `waiting-on-me` → **Blocked** → **Working** →
**Done**, then most recent. `working` ranks low on purpose: the agent has it, so
it is the one row making progress without you.

**Dragging a card writes a pin.** Between stage columns it sets the same manual
stage the Brief panel does; onto **Done** it pins the status. Both are anchored to
the thread's activity cursor, so a dragged card carries a `pinned` marker and
retires on the next real turn — which is why the marker is there rather than
letting the card appear to move back by itself. Three rules that are not
obvious:

- Dropping a card on the stage the summarizer **already** judged *clears* the pin
  instead of setting one. Dragging a card back to where it would sit by itself is
  a statement that the model was right, and pinning it there would leave a pin
  that does nothing until it silently expires.
- Dragging **out of** Done pins `waiting-on-me` rather than clearing the status
  pin, because a done reading can come from the model as well as from a pin —
  and clearing in that case would hand the card straight back to a model reading
  that still says done, snapping it into the column you just dragged it out of.
- **No stage** is not a drop target in either direction.

Drag-and-drop is a pointer affordance, so the expanded card carries the panel's
own stage and status controls. That is the whole mobile story: on a compact
viewport the columns stack into one scrolling list with their headers as section
headings, same cards, same data path, and the pins are taps. A collapsed column
stacks as a full-width strip with its label the right way up, since a vertical
rail is only worth it where the columns are side by side.

**The whole view is remembered, in local storage.** Filters and rails go into one
line — `status:waiting-on-me/expand:done` — written when you change either and
read once when the board mounts, so opening the page from the sidebar lands where
you left it. Filters and rails are independent: clearing a filter is not a request
to close Done again. Anything unrecognised in the line is ignored rather than
fatal, because the line outlives the build that wrote it: `expand:` is additive,
so a line stored before it existed still parses, and one stored after still parses
in a build without it.

The panel's `subPath` was the obvious home for this and is the one place it
cannot live. `useBbNavigate().toPluginPanel` percent-encodes each path segment on
the way out, and react-router 7 hands params back raw — it undoes `%2F` and
nothing else — so `status:done` left as `status%3Adone` and came back unparsable.
Every filter read as "no filter" and the page looked dead: chips lit nothing,
rails would not open. A board is somewhere you return to rather than something
you send, so the linkability the URL bought was not worth a view that does not
survive its own round trip.

**Where the data comes from** is the same split as the row glyphs. One
`listBriefCards` call — a single kv scan, no per-thread lookups — carries the
stored facts, and everything live (title, project, pin, whether the agent is
running, the attention cursor) is already in bb's own cache behind
`experimental_useSidebarThreads`, which costs no request and updates exactly when
the built-in sidebar does. The two are folded together by pure functions in
`board.ts`, so which column a thread lands in and what a drop writes are tested
without mounting anything.

The **count on the sidebar row** — bb calls it a panel accessory — is threads
waiting on you, and it costs nothing: the overlay that draws the row glyphs has
already folded the briefs against the live thread list, so the badge reads that
same store rather than making a second request per window. Nothing is drawn at
zero; the accessory shares the row's trailing column with bb's own options
button, so the only badge worth the space is one that means "look here".

## Auto-archiving finished threads

A thread whose brief says **done** and which has had no activity for two days is
archived.

```sh
bb plugin config thread-briefs set doneArchiveHours 48   # 0 turns it off
```

The [grey ring](#where-briefs-show-up) is the warning: both go through the same
`isStaleDone`, so a ring that has lost its colour is exactly a thread the next
sweep will take once the second threshold passes. A day of grey is the notice
period.

Done is not "nothing left anywhere": a done thread may still carry a step that is
yours alone, such as approving a PR, and it is archived on the same clock. That
is deliberate. The step stays on the card in the Done section for two days and
the hover label says "archiving soon" for the second; a thread archived anyway is
one click from back, and un-archiving it is final (below). Waiting on you would
have kept it in the sidebar indefinitely, which is the failure this status was
rewritten to fix.

Every other rule is a reason *not* to archive, which is the right default for a
sweep that runs unattended — a thread wrongly left in the sidebar costs a glance,
a thread wrongly archived costs a search for something you believe you left on
screen:

- **A pinned thread is never archived.** A pin is a deliberate "keep this in
  front of me" and outranks anything inferred. It still greys.
- **A thread with no brief is never archived.** Briefs are never backfilled, so a
  briefless thread is one this plugin has never read; it has no claim to make
  about whether the work is finished.
- **Un-archiving is final.** The brief records `autoArchivedAt` when the sweep
  takes a thread, and a thread carrying it is never auto-archived again — so
  pulling one back out is not an argument you have to win every hour. That
  exemption lasts exactly as long as the thread stays untouched: a summary writes
  a fresh brief row without the stamp, so working in the thread again puts it
  back in the normal cycle.
- **Nothing busy, hidden, deleted or already archived** is touched.

The sweep runs hourly on its own schedule rather than inside the brief sweep,
which returns early with no API key — archiving a finished thread has nothing to
do with whether a summarizer is configured. Its thresholds are compared in days,
so a sweep running up to an hour late is invisible.

## How it is built

| Concern | Mechanism |
| --- | --- |
| Trigger | `bb.events.on("thread.idle")` + a per-thread quiet-period debounce, with a `*/10 * * * *` sweep as the backstop. A thread with no brief yet skips the quiet period, and is summarized from `thread.active` as well — mid-turn, so a long first turn is not spent briefless |
| Summarizer input | `threads.conversationOutline()` head + tail with the middle elided, `threads.output()` for the last message in full, and the previous brief's title, goal, currentState and constraints |
| Storage | `bb.storage.kv`, one row per thread at `brief:<threadId>` |
| Sidebar glyph | a content script's `experimental_setThreadRowStatus`, fed by an `experimental_appOverlay` that owns the rpc + realtime subscription |
| Ring artwork | `app.experimental_icons.register`, one inline SVG per stage plus the done ring, in every palette colour, plus one grey done ring — since a row status takes an icon *name* and not a component, every combination has to be registered at init, before any project is known |
| Auto-archive | a `17 * * * *` `bb.background.schedule` over `threads.list`, `planArchives` deciding purely, `threads.archive` doing it, and `autoArchivedAt` on the brief row remembering it |
| Brief UI | a `threadPanelAction` tab, opened by an `experimental_threadHeaderAction` button through `useBbNavigate().openThreadPanel` |
| Board | a `navPanel` with an `experimental_sidebarAccessory`, one `listBriefCards` call joined on the client to `experimental_useSidebarThreads`, the view in component state and mirrored to local storage (*not* the panel's `subPath` — see above), and every rule — columns, order, drops, view parsing — pure in `board.ts` |
| Re-entry refresher | an `app.composer.customize({banners})` card scoped to `thread`, `chrome: "bare"`, deciding nothing itself: one `getRefresher` call on mount, `onSubmitted` for the send that retires it |
| Sidebar sections | `bb.sdk.threadSections` + `threads.update({sectionId})`, with `thread-list`'s own `organizationMode` / `manualSectionOrder` preferences set through `bb.sdk.plugins.callRpc` |
| Thread titles | `threads.update({title})`, gated on `planRename` comparing the thread's title against the one this plugin last wrote |

### Why the refresher is decided on the server, in one call

Everything the decision reads is server-side: the stored prose, the effective
status with its overrides, the thread's `latestAttentionAt`, and the dismissal
record. Splitting it would mean shipping all four to the client to recombine
them there. So the client asks once when the banner mounts and renders the
sentence it is handed — which also means the *whole* rule lives in one pure
function, `chooseRefresher`, rather than spread across a component's effects.

`latestAttentionAt` rather than `updatedAt` is load-bearing. This plugin writes
thread titles and section assignments, and both move `updatedAt` — counting our
own rename as activity would reset the idle clock on exactly the threads the
refresher exists for.

The one thing the client decides is when to stop showing it, because that is the
one input the server cannot see: a send, through
`useComposer().onSubmitted`.

### Why a content script rather than a list fork

bb exposes exactly one slot that owns thread rows,
`app.slots.experimental_threadList`, and it is *exclusive* — a plugin either
replaces the whole sidebar list or touches none of it. The per-row hooks
(`useSidebarThreadDraft`, `useSidebarThreadRowStatus`, …) are for a replacement
list to *consume*, not injection points into bb's own list. Inline row
expansion therefore means forking `plugins/thread-list` (~28k lines) and
re-merging it forever, so this plugin uses the additive surfaces bb supports
instead: a row glyph, a header button onto a side-panel tab, and — for everything
that genuinely needs more room than a row has — [a page of its own](#the-board).
The board is what the inline expansion was really for: it shows more per thread
than a row ever could, without owning a single row.

### Why `thread.idle` rather than polling

`bb.events.on("thread.idle", …)` delivers the thread DTO on every transition
into idle, which is the turn-completion signal a poll would be approximating.
Polling remains only as the 10-minute sweep, for activity whose event never
arrived — a server restart, a plugin reload, or a turn that ended in `error`
rather than idle.

### Why renaming is safe, and why it needs bookkeeping

bb's `applyGeneratedThreadTitle` refuses to write over an existing title, and it
is the only automatic writer, so a title this plugin writes will not be
overwritten by bb. The risk runs the other way: a `threads` row carries no
provenance for its title — there is no column saying whether it came from bb's
guess, a rename, or us — so "is this name mine to change?" can only be answered
from memory. `appliedTitle` on the brief row is that memory, and `planRename` is
the whole rule, kept pure and tested away from the effect.

### Why sections rather than a grouping mode

Grouping the sidebar by status needs no fork either, because a section is core bb
state: `thread-list` renders whatever sections exist when its `organizationMode`
is `chronological`, so assigning threads to sections *is* the grouping. The sync
reconciles in one full pass — one `threads.list` plus one kv scan — rather than
per changed brief: it costs less than a `threads.get` per thread once a batch is
more than a handful, it is self-healing after a write we missed, and startup and
steady state run the same code. The debounce is what turns a burst of brief
writes into a single pass, so the preference writes happen once per batch.

Section display order is creation order as far as bb is concerned — a
`ThreadSection` has no position field — so the sync both creates the sections in
display order and pins that order in `manualSectionOrder`.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```
